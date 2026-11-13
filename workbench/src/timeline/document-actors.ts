import assert from "node:assert/strict";
import type { Agenda } from "./agenda.js";
import type { TimelineDocument } from "./contract.js";
import { DocumentTransport, type Connection } from "./document-transport.js";
import { RuntimeTurns, type PublicationAttempt } from "./runtime-turns.js";
import { RetryController } from "./retry-controller.js";
import { type RetryPolicy } from "./retry-policy.js";
import type { AdmittedAction } from "./lifecycle.js";
import { encodeJson, type Json } from "./json.js";
import { list, object, text } from "./validation.js";
import { SemanticTrace, metadataJson as j } from "./semantic-trace.js";

/** Owns actor connections, retained publication attempts and external retry timers. */
export class DocumentActors {
  readonly retries: RetryController;
  private readonly attempts = new Map<string, number>();
  private readonly connections = new Map<string, Connection>();
  private readonly actors: { id: string; role: string }[];
  private stopCause?: string;
  private readonly publications = new Map<string, string>();
  constructor(
    private readonly agenda: Agenda,
    private readonly runtime: RuntimeTurns,
    private readonly transport: DocumentTransport,
    private readonly scenario: TimelineDocument,
    private readonly trace: SemanticTrace,
  ) {
    for (const value of list(scenario.document.publications, "publications")) {
      const publication = object(value, "publication");
      this.publications.set(
        text(publication.id, "id"),
        encodeJson(publication.body),
      );
    }
    this.retries = new RetryController(scenario.retryPolicies, {
      agenda: this.agenda,
      turn: this.runtime.lifecycle
        ? () => this.runtime.consumeExecutionTurn()
        : undefined,
      event: (kind, data, parent, actor, generation, causes) =>
        this.trace.event(
          kind,
          this.agenda.current,
          actor,
          this.runtime.lifecycle ? null : generation,
          parent,
          data,
          causes,
          this.runtime.lifecycle ? null : this.runtime.generation,
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
      connection?.runtimeGeneration ?? this.runtime.generation,
    );
  }
  private async retryPublication(
    policy: RetryPolicy,
    attempt: number,
    parent: string,
  ) {
    if (this.runtime.lifecycle && !this.runtime.available) {
      const cause = this.trace.event(
        "retry-attempt",
        this.agenda.current,
        policy.actor,
        null,
        parent,
        j({
          actionId: policy.action,
          publication: policy.publication,
          attempt,
        }),
        [],
        null,
      );
      this.unavailable(
        policy.actor,
        policy.action,
        policy.publication,
        attempt,
        cause,
      );
      return;
    }
    const previous = this.connections.get(policy.actor);
    if (previous?.attached) {
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
    const connection = this.allocate(policy.actor);
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
    this.connected(connection);
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
      this.attempts.set(
        JSON.stringify([policy.actor, policy.publication]),
        attempt,
      );
      await this.transport.sendToRuntime(
        connection,
        {
          op: "ingress",
          session: connection.session,
          wire: this.publications.get(policy.publication)!,
        },
        send,
        { action: policy.action, attempt },
      );
    });
  }
  async action(admitted: AdmittedAction, action: { [key: string]: Json }) {
    if (this.runtime.lifecycle) this.runtime.consumeExecutionTurn();
    const kind = text(action.kind, "kind");
    const actor = this.actors.find(
      (candidate) => candidate.id === admitted.actor,
    )!;
    let connection = this.connections.get(actor.id);
    const data = this.actionData(action);
    if (
      this.runtime.lifecycle &&
      (kind.startsWith("source-") ||
        (kind === "connect" && !this.runtime.available))
    ) {
      const cause = this.trace.event(
        "action",
        this.agenda.current,
        actor.id,
        this.runtime.available && connection?.open
          ? connection.generation
          : null,
        null,
        data,
        [],
        this.runtime.generation,
      );
      if (kind === "connect") {
        this.trace.event(
          "connection-outcome",
          this.agenda.current,
          actor.id,
          null,
          cause,
          j({ outcome: "connection-unavailable" }),
          [this.stopCause!],
          null,
        );
        return;
      }
      const publication = text(action.publication, "publication");
      const key = JSON.stringify([actor.id, publication]);
      const attempt = (this.attempts.get(key) ?? 0) + 1;
      this.attempts.set(key, attempt);
      if (!this.runtime.available) {
        this.unavailable(actor.id, admitted.id, publication, attempt, cause);
        return;
      }
      const managed = this.scenario.retryPolicies.find(
        (policy) => policy.action === admitted.id,
      );
      if (managed && !connection?.open) {
        connection = this.allocate(actor.id);
        const connect = this.event(
          "retry-lifecycle",
          j({ actionId: admitted.id, operation: "connect", attempt }),
          cause,
          connection,
        );
        await this.runtime.command(
          { op: "connect", role: "source", session: connection.session },
          connect,
        );
        this.connected(connection);
      }
      assert.ok(connection?.open, "source requires a current connection");
      await this.sendPublication(
        connection,
        admitted.id,
        publication,
        attempt,
        cause,
      );
      return;
    }
    if (kind === "connect") {
      assert.ok(
        !connection?.open,
        "reconnect cannot replace an open connection",
      );
      connection = this.allocate(actor.id, admitted.connectionGeneration);
    }
    assert.ok(connection, "action has a declared connection generation");
    if (!this.runtime.lifecycle)
      assert.equal(connection.generation, admitted.connectionGeneration);
    if (kind !== "disconnect" && kind !== "connect")
      assert.ok(
        connection.open,
        "action cannot use a runtime-closed connection",
      );
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
      operation = {
        op: "ingress",
        session: connection.session,
        wire: this.publications.get(text(action.publication, "publication"))!,
      };
    } else
      operation = {
        op: "subscribe",
        session: connection.session,
        wire: encodeJson({
          action: kind === "client-subscribe" ? "subscribe" : "unsubscribe",
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
    if (kind === "connect") this.connected(connection);
    if (kind === "disconnect") {
      connection.open = false;
      connection.attached = false;
    }
  }
  private actionData(action: { [key: string]: Json }) {
    const data: { [key: string]: Json } = {
      ...action,
      actionId: action.id,
      actionKind: action.kind,
    };
    for (const key of ["id", "atMs", "kind", "actor"]) delete data[key];
    return data;
  }
  private allocate(actor: string, declared?: number): Connection {
    const generation =
      declared ?? (this.connections.get(actor)?.generation ?? 0) + 1;
    const connection: Connection = {
      actor,
      generation,
      session: `connection-${this.actors.findIndex((candidate) => candidate.id === actor)}-${generation}`,
      open: !this.runtime.lifecycle,
      attached: !this.runtime.lifecycle,
      ...(this.runtime.lifecycle
        ? { runtimeGeneration: this.runtime.generation! }
        : {}),
    };
    if (!this.runtime.lifecycle) this.connected(connection);
    return connection;
  }
  private connected(connection: Connection) {
    connection.open = true;
    connection.attached = true;
    this.connections.set(connection.actor, connection);
    this.transport.register(connection);
  }
  private async sendPublication(
    connection: Connection,
    action: string,
    publicationId: string,
    attempt: number,
    cause: string,
  ) {
    this.retries.begin(action, attempt, connection.generation, cause);
    await this.transport.sendToRuntime(
      connection,
      {
        op: "ingress",
        session: connection.session,
        wire: this.publications.get(publicationId)!,
      },
      cause,
      { action, attempt },
    );
  }
  private unavailable(
    actor: string,
    action: string,
    publication: string,
    attempt: number,
    parent: string,
  ) {
    const cause = this.trace.event(
      "attempt-outcome",
      this.agenda.current,
      actor,
      null,
      parent,
      j({ publication, attempt, outcome: "connection-unavailable" }),
      [this.stopCause!],
      null,
    );
    this.retries.unavailable(action, attempt, cause);
  }
  stopped(cause: string) {
    this.stopCause = cause;
  }
  connection(actor: string) {
    return this.connections.get(actor);
  }
}
