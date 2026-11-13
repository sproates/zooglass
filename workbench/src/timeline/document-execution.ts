import assert from "node:assert/strict";
import { Agenda } from "./agenda.js";
import { Bridge, type Effect, type Response } from "./bridge.js";
import type { TimelineDocument } from "./contract.js";
import { encodeJson, parseJson, type Json } from "./json.js";
import { integer, list, object, text } from "./validation.js";
import {
  SemanticTrace,
  metadataJson as j,
  type Counts,
} from "./semantic-trace.js";
import type { executionSettings } from "./document-profile.js";

type Connection = {
  actor: string;
  session: string;
  generation: number;
  open: boolean;
};
type Handoff = { id: string; messageId: string; envelope: Json };
export class DocumentExecution {
  readonly agenda: Agenda;
  last?: Response;
  private turns = 0;
  private messages = 0;
  private messageSequence = 0;
  private readonly connections = new Map<string, Connection>();
  private readonly sessions = new Map<string, Connection>();
  private readonly handoffs = new Map<string, Handoff>();
  private readonly tasks = new Map<number, string>();
  private readonly observations = new Map<string, Json[]>();
  private readonly actors: { id: string; role: string }[];
  constructor(
    readonly bridge: Bridge,
    readonly scenario: TimelineDocument,
    readonly trace: SemanticTrace,
    readonly limits: ReturnType<typeof executionSettings>,
  ) {
    this.agenda = new Agenda(limits);
    this.actors = list(scenario.document.actors, "actors").map((item) => {
      const actor = object(item, "actor");
      return { id: text(actor.id, "id"), role: text(actor.role, "role") };
    });
    for (const actor of this.actors) this.observations.set(actor.id, []);
  }
  private turn() {
    if (++this.turns > this.limits.turns)
      throw new Error("limit-exceeded: execution turns");
  }
  private messageBound() {
    if (this.messages + this.handoffs.size > this.limits.pendingMessages)
      throw new Error("limit-exceeded: pending messages");
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
  private async command(operation: Record<string, unknown>, parent: string) {
    this.turn();
    const response = await this.bridge.command(
      this.agenda.current[0],
      operation,
    );
    this.last = response;
    for (const effect of response.effects) this.effect(effect, parent);
  }
  private effect(effect: Effect, parent: string) {
    if (effect.kind === "schedule") {
      assert.ok(
        Number.isSafeInteger(effect.task) &&
          effect.task! > 0 &&
          !this.tasks.has(effect.task!),
      );
      assert.ok(
        Number.isSafeInteger(effect.at) && effect.at! >= this.agenda.current[0],
      );
      assert.ok([0, 1, 2].includes(effect.phase!));
      const id = this.event(
        "scheduled",
        j({
          taskId: String(effect.task),
          atMs: effect.at,
          phase: effect.phase,
          taskKind: effect.taskKind,
        }),
        parent,
      );
      this.tasks.set(effect.task!, id);
      this.agenda.add(
        effect.at!,
        effect.phase!,
        async () => {
          assert.equal(
            this.tasks.get(effect.task!),
            id,
            "task retains its scheduling owner",
          );
          this.tasks.delete(effect.task!);
          const dispatch = this.event(
            "task-dispatched",
            j({ taskId: String(effect.task) }),
            id,
          );
          await this.command({ op: "task", task: effect.task }, dispatch);
        },
        effect.task,
      );
      return;
    }
    if (effect.kind === "cancel") {
      const owner = this.tasks.get(effect.task!);
      assert.ok(owner, "cancellation identifies a pending scheduled task");
      this.event(
        "cancelled",
        j({ taskId: String(effect.task) }),
        parent,
        undefined,
        [owner],
      );
      this.tasks.delete(effect.task!);
      this.agenda.cancel(effect.task!);
      return;
    }
    if (effect.kind === "state") {
      this.event("state", { envelope: parseJson(effect.wire!) }, parent);
      return;
    }
    const connection = this.sessions.get(effect.session!);
    assert.ok(
      connection,
      `effect names a known connection generation: ${effect.session}`,
    );
    if (effect.kind === "close") {
      connection.open = false;
      const closed = this.event(
        "connection-closed",
        j({ code: effect.code }),
        parent,
        connection,
      );
      const held = this.handoffs.get(connection.session);
      if (held) {
        this.event(
          "dropped",
          {
            ...(j({
              messageId: held.messageId,
              channel: "client-frame",
              reason: "connection-closed",
            }) as { [key: string]: Json }),
            envelope: held.envelope,
          },
          closed,
          connection,
          [held.id],
        );
        this.handoffs.delete(connection.session);
      }
      return;
    }
    const envelope = parseJson(effect.wire!);
    if (effect.kind === "handoff") {
      assert.ok(
        !this.handoffs.has(connection.session),
        "one in-flight handoff per connection",
      );
      // Message identity is stable and allocated at the actual handoff, before completion.
      const messageId = `message-${this.messageSequence++}`;
      const id = this.event(
        "handoff",
        { ...(j({ messageId }) as { [key: string]: Json }), envelope },
        parent,
        connection,
      );
      this.handoffs.set(connection.session, { id, messageId, envelope });
      this.messageBound();
      return;
    }
    assert.ok(
      effect.kind === "frame" || effect.kind === "receipt",
      `known effect kind ${effect.kind}`,
    );
    let causes: string[] = [];
    let messageId: string;
    if (effect.kind === "frame") {
      const handoff = this.handoffs.get(connection.session);
      assert.ok(handoff, "frame completes an actual handoff");
      assert.equal(
        encodeJson(envelope),
        encodeJson(handoff.envelope),
        "completion retains handoff bytes",
      );
      messageId = handoff.messageId;
      causes = [handoff.id];
      this.handoffs.delete(connection.session);
    } else messageId = `message-${this.messageSequence++}`;
    const sent = this.event(
      effect.kind,
      { envelope, messageId },
      parent,
      connection,
      causes,
    );
    this.messages++;
    this.messageBound();
    this.agenda.add(this.agenda.current[0], 2, async () => {
      this.turn();
      this.messages--;
      const delivered = connection.open;
      this.event(
        delivered ? "delivered" : "dropped",
        {
          ...(j({
            messageId,
            channel:
              effect.kind === "receipt" ? "source-receipt" : "client-frame",
            ...(delivered ? {} : { reason: "connection-closed" }),
          }) as { [key: string]: Json }),
          envelope,
        },
        sent,
        connection,
      );
      if (delivered) this.observations.get(connection.actor)!.push(envelope);
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
    await this.command({ op: "initialize-document", wire, epochMillis }, cause);
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
            };
            this.connections.set(actor.id, connection);
            this.sessions.set(connection.session, connection);
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
          if (kind === "connect")
            operation = {
              op: "connect",
              role: actor.role,
              session: connection.session,
            };
          else if (kind === "disconnect")
            operation = { op: "disconnect", session: connection.session };
          else if (kind === "writer-stall")
            operation = { op: "stall", session: connection.session };
          else if (kind === "writer-release")
            operation = {
              op: "release",
              session: connection.session,
              fail: action.fail,
            };
          else if (kind.startsWith("source-")) {
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
          await this.command(operation, cause);
          if (kind === "disconnect") connection.open = false;
        },
        undefined,
        true,
      );
    }
  }
  async settle(at: number) {
    await this.agenda.through(at);
    const cause = this.event("runtime-command", j({ op: "observe" }), null);
    await this.command({ op: "observe" }, cause);
    assert.deepEqual(
      this.last!.effects,
      [],
      "settled observation cannot repair overdue work",
    );
  }
  assertObservation(assertion: { [key: string]: Json }) {
    this.turn();
    const actor = text(assertion.actor, "actor");
    const actual = this.observations.get(actor)!;
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
      pendingFutureTasks: this.last?.pendingTasks ?? 0,
      pendingMessages: this.messages + this.handoffs.size,
      heldFrames: this.last?.heldFrames ?? 0,
    };
  }
  checkEnd() {
    const end = object(this.scenario.document.end, "end");
    const counts = this.counts();
    assert.equal(
      this.tasks.size,
      counts.pendingFutureTasks,
      "runtime/agenda pending-task accounting",
    );
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
      await this.command({ op: "shutdown" }, cause);
    });
    await this.agenda.through(this.agenda.current[0]);
    assert.equal(
      this.agenda.pending().length,
      0,
      "shutdown leaves no model work",
    );
  }
}
