import assert from "node:assert/strict";
import { Agenda } from "./agenda.js";
import type { Bridge } from "./bridge.js";
import type { TimelineDocument } from "./contract.js";
import { DocumentTransport, type Connection } from "./document-transport.js";
import { RuntimeTurns, type PublicationAttempt } from "./runtime-turns.js";
import { RetryController } from "./retry-controller.js";
import { retryPolicies, type RetryPolicy } from "./retry-policy.js";
import { encodeJson, type Json } from "./json.js";
import { integer, list, object, text } from "./validation.js";
import {
  SemanticTrace,
  metadataJson as j,
  type Counts,
} from "./semantic-trace.js";
import type { executionSettings } from "./document-profile.js";

/** Coordinates declared actor actions, managed retries and scenario assertions. */
export class DocumentExecution {
  readonly agenda: Agenda;
  private readonly runtime: RuntimeTurns;
  private readonly transport: DocumentTransport;
  private readonly retries: RetryController;
  private readonly attempts = new Map<string, number>();
  private readonly connections = new Map<string, Connection>();
  private readonly actors: { id: string; role: string }[];
  constructor(
    readonly bridge: Bridge,
    readonly scenario: TimelineDocument,
    readonly trace: SemanticTrace,
    readonly limits: ReturnType<typeof executionSettings>,
  ) {
    this.agenda = new Agenda(limits);
    this.runtime = new RuntimeTurns(
      bridge,
      this.agenda,
      trace,
      limits.turns,
      (effect, parent, publication) =>
        this.transport.effect(effect, parent, publication),
    );
    this.transport = new DocumentTransport(
      this.agenda,
      scenario,
      trace,
      limits.pendingMessages,
      {
        consumeExecutionTurn: () => this.runtime.consumeExecutionTurn(),
        command: (operation, parent, publication) =>
          this.runtime.command(operation, parent, publication),
        receipt: (action, attempt, generation, parent) =>
          this.retries.receipt(action, attempt, generation, parent),
      },
    );
    this.retries = new RetryController(retryPolicies(scenario.document), {
      agenda: this.agenda,
      event: (kind, data, parent, actor, generation, causes) =>
        this.trace.event(
          kind,
          this.agenda.current,
          actor,
          generation,
          parent,
          data,
          causes,
        ),
      retry: (policy, attempt, parent) =>
        this.retryPublication(policy, attempt, parent),
    });
    this.actors = list(scenario.document.actors, "actors").map((item) => {
      const actor = object(item, "actor");
      return { id: text(actor.id, "id"), role: text(actor.role, "role") };
    });
  }
  private event(
    kind: string,
    data: Json,
    parent: string | null,
    connection?: Connection,
    causes: string[] = [],
  ) {
    return this.trace.event(
      kind,
      this.agenda.current,
      connection?.actor ?? "@runtime",
      connection?.generation ?? null,
      parent,
      data,
      causes,
    );
  }
  private async retryPublication(
    policy: RetryPolicy,
    attempt: number,
    parent: string,
  ) {
    const previous = this.connections.get(policy.actor)!;
    if (previous.attached) {
      const close = this.event(
        "retry-lifecycle",
        j({ actionId: policy.action, operation: "disconnect", attempt }),
        parent,
        previous,
      );
      await this.runtime.command(
        { op: "disconnect", session: previous.session },
        close,
      );
      previous.open = false;
      previous.attached = false;
    }
    const connection: Connection = {
      actor: policy.actor,
      session: `connection-${this.actors.findIndex((actor) => actor.id === policy.actor)}-${previous.generation + 1}`,
      generation: previous.generation + 1,
      open: true,
      attached: true,
    };
    this.connections.set(policy.actor, connection);
    this.transport.register(connection);
    const connect = this.event(
      "retry-lifecycle",
      j({ actionId: policy.action, operation: "connect", attempt }),
      parent,
      connection,
    );
    await this.runtime.command(
      { op: "connect", role: "source", session: connection.session },
      connect,
    );
    this.agenda.add(this.agenda.current[0], 2, async () => {
      const send = this.event(
        "retry-attempt",
        j({
          actionId: policy.action,
          publication: policy.publication,
          attempt,
        }),
        connect,
        connection,
      );
      this.retries.begin(policy.action, attempt, connection.generation, send);
      const publication = list(
        this.scenario.document.publications,
        "publications",
      )
        .map((p) => object(p, "publication"))
        .find((p) => p.id === policy.publication)!;
      this.attempts.set(
        JSON.stringify([policy.actor, policy.publication]),
        attempt,
      );
      await this.transport.sendToRuntime(
        connection,
        {
          op: "ingress",
          session: connection.session,
          wire: encodeJson(publication.body),
        },
        send,
        { action: policy.action, attempt },
      );
    });
  }
  async initialize(
    wire: string,
    configurationSha256: string,
    epochMillis: number,
  ) {
    const cause = this.event(
      "runtime-command",
      j({ op: "initialize-document", configurationSha256, epochMillis }),
      null,
    );
    await this.runtime.command(
      { op: "initialize-document", wire, epochMillis },
      cause,
    );
  }
  preload() {
    const actions = list(this.scenario.document.actions, "actions");
    for (const admitted of this.scenario.admittedActions) {
      const action = object(actions[admitted.declaration], "action");
      this.agenda.add(
        admitted.atMs,
        admitted.phase,
        async () => {
          const kind = text(action.kind, "kind");
          const actor = this.actors.find(
            (candidate) => candidate.id === admitted.actor,
          )!;
          let connection = this.connections.get(actor.id);
          if (kind === "connect") {
            assert.ok(
              !connection?.open,
              "reconnect cannot replace an open connection",
            );
            connection = {
              actor: actor.id,
              session: `connection-${this.actors.indexOf(actor)}-${admitted.connectionGeneration}`,
              generation: admitted.connectionGeneration,
              open: true,
              attached: true,
            };
            this.connections.set(actor.id, connection);
            this.transport.register(connection);
          }
          assert.ok(connection, "action has a declared connection generation");
          assert.equal(connection.generation, admitted.connectionGeneration);
          if (kind !== "disconnect")
            assert.ok(
              connection.open,
              "action cannot use a runtime-closed connection",
            );
          const data = {
            ...action,
            actionId: action.id,
            actionKind: action.kind,
          };
          delete (data as Record<string, unknown>).id;
          delete (data as Record<string, unknown>).atMs;
          delete (data as Record<string, unknown>).kind;
          delete (data as Record<string, unknown>).actor;
          const cause = this.event("action", data, null, connection);
          let operation: Record<string, unknown>;
          let publicationAttempt: PublicationAttempt | undefined;
          if (kind === "connect")
            operation = {
              op: "connect",
              role: actor.role,
              session: connection.session,
            };
          else if (kind === "disconnect") {
            // A fault already removed this source from the host. Keep the declared
            // lifecycle action, while closed client sessions still receive cleanup.
            if (!connection.attached) return;
            operation = { op: "disconnect", session: connection.session };
          } else if (kind === "writer-stall")
            operation = { op: "stall", session: connection.session };
          else if (kind === "writer-release")
            operation = {
              op: "release",
              session: connection.session,
              fail: action.fail,
            };
          else if (kind.startsWith("source-")) {
            const attemptKey = JSON.stringify([actor.id, action.publication]);
            const attempt = (this.attempts.get(attemptKey) ?? 0) + 1;
            this.attempts.set(attemptKey, attempt);
            publicationAttempt = {
              action: text(action.id, "action.id"),
              attempt,
            };
            const publication = list(
              this.scenario.document.publications,
              "publications",
            )
              .map((p) => object(p, "publication"))
              .find((p) => p.id === action.publication)!;
            operation = {
              op: "ingress",
              session: connection.session,
              wire: encodeJson(publication.body),
            };
          } else
            operation = {
              op: "subscribe",
              session: connection.session,
              wire: encodeJson({
                action:
                  kind === "client-subscribe" ? "subscribe" : "unsubscribe",
                viewId: action.viewId,
                entityId: action.entityId,
              }),
            };
          if (publicationAttempt)
            this.retries.begin(
              publicationAttempt.action,
              publicationAttempt.attempt,
              connection.generation,
              cause,
            );
          if (operation.op === "ingress" || operation.op === "subscribe")
            await this.transport.sendToRuntime(
              connection,
              operation,
              cause,
              publicationAttempt,
            );
          else await this.runtime.command(operation, cause, publicationAttempt);
          if (kind === "disconnect") {
            connection.open = false;
            connection.attached = false;
          }
        },
        undefined,
        true,
      );
    }
  }
  async settle(at: number) {
    await this.agenda.through(at);
    const cause = this.event("runtime-command", j({ op: "observe" }), null);
    await this.runtime.command({ op: "observe" }, cause);
    assert.deepEqual(
      this.runtime.last!.effects,
      [],
      "settled observation cannot repair overdue work",
    );
  }
  assertObservation(assertion: { [key: string]: Json }) {
    this.runtime.consumeExecutionTurn();
    const actor = text(assertion.actor, "actor");
    const actual = this.transport.observed(actor);
    const passed = encodeJson(assertion.expected) === encodeJson(actual);
    const connection = this.connections.get(actor);
    this.trace.event(
      "assertion",
      this.agenda.current,
      actor,
      connection?.generation ?? null,
      null,
      {
        ...(j({
          assertionId: assertion.id,
          assertionKind: assertion.kind,
          atMs: integer(assertion.atMs, "atMs"),
          passed,
        }) as { [key: string]: Json }),
        expected: assertion.expected,
        actual,
      },
    );
    if (!passed)
      throw new Error(`assertion-failed: ${text(assertion.id, "id")}`);
  }
  counts(): Counts {
    return {
      pendingFutureTasks:
        (this.runtime.last?.pendingTasks ?? 0) + this.retries.pending(),
      pendingMessages: this.transport.pending(),
      heldFrames: this.runtime.last?.heldFrames ?? 0,
    };
  }
  checkEnd() {
    const end = object(this.scenario.document.end, "end");
    const counts = this.counts();
    this.runtime.checkPending();
    if (this.retries.unfinished())
      throw new Error("assertion-failed: unfinished retry actor at horizon");
    if (
      counts.pendingMessages ||
      counts.heldFrames ||
      (end.pendingFutureTasks === "forbid" && counts.pendingFutureTasks)
    )
      throw new Error("assertion-failed: end conditions");
    return counts;
  }
  async shutdown() {
    this.agenda.add(this.agenda.current[0], 0, async () => {
      const cause = this.event("runtime-command", j({ op: "shutdown" }), null);
      await this.runtime.command({ op: "shutdown" }, cause);
    });
    await this.agenda.through(this.agenda.current[0]);
    assert.equal(
      this.agenda.pending().length,
      0,
      "shutdown leaves no model work",
    );
  }
}
