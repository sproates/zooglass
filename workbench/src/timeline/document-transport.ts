import assert from "node:assert/strict";
import type { Agenda } from "./agenda.js";
import type { SessionEffect } from "./bridge.js";
import type { TimelineDocument } from "./contract.js";
import { DelayedLinks, type LinkChannel } from "./delayed-links.js";
import { encodeJson, parseJson, type Json } from "./json.js";
import { receiptRules, receiptDraw } from "./receipt-faults.js";
import type { PublicationAttempt } from "./runtime-turns.js";
import { SemanticTrace, metadataJson as j } from "./semantic-trace.js";
import { integer, list, object, text } from "./validation.js";

export type Connection = {
  actor: string;
  session: string;
  generation: number;
  runtimeGeneration?: number;
  open: boolean;
  attached: boolean;
  closedBy?: string;
};
type Handoff = { id: string; messageId: string; envelope: Json };

type Ports = {
  consumeExecutionTurn: () => void;
  command: (
    operation: Record<string, unknown>,
    parent: string,
    publication?: PublicationAttempt,
  ) => Promise<void>;
  receipt: (
    action: string,
    attempt: number,
    generation: number,
    parent: string,
  ) => void;
};

/** Owns session-bound messages from ingress through handoff, delay, loss and arrival. */
export class DocumentTransport {
  private readonly queued = new Map<
    number,
    { connection: Connection; cancel: (cause: string) => void }
  >();
  private readonly faultTasks = new Map<string, number>();
  private messages = 0;
  private messageSequence = 0;
  private readonly links: DelayedLinks;
  private readonly latencies = new Map<string, number>();
  private readonly rules: ReturnType<typeof receiptRules>;
  private readonly pendingFaultCloses = new Set<string>();
  private readonly sessions = new Map<string, Connection>();
  private readonly handoffs = new Map<string, Handoff>();
  private readonly observations = new Map<string, Json[]>();
  constructor(
    private readonly agenda: Agenda,
    private readonly scenario: TimelineDocument,
    private readonly trace: SemanticTrace,
    private readonly pendingMessageLimit: number,
    private readonly ports: Ports,
  ) {
    this.rules = receiptRules(scenario.document);
    for (const value of list(scenario.document.links, "links")) {
      const link = object(value, "link");
      this.latencies.set(
        text(link.actor, "actor"),
        integer(link.latencyMs, "latencyMs"),
      );
    }
    this.links = new DelayedLinks({
      agenda: this.agenda,
      event: (kind, data, parent, connection, causes) =>
        this.trace.event(
          kind,
          this.agenda.current,
          connection.actor,
          connection.generation,
          parent,
          data,
          causes,
          connection.runtimeGeneration ?? 1,
        ),
      turn: () => this.ports.consumeExecutionTurn(),
      checkBound: () => this.messageBound(),
    });

    for (const value of list(scenario.document.actors, "actors"))
      this.observations.set(text(object(value, "actor").id, "id"), []);
  }
  register(connection: Connection) {
    this.sessions.set(connection.session, connection);
  }
  observed(actor: string): Json[] {
    return this.observations.get(actor)!;
  }
  pending(): number {
    return this.messages + this.handoffs.size + this.links.pending();
  }
  private messageBound() {
    if (this.pending() > this.pendingMessageLimit)
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
      connection?.runtimeGeneration ?? 1,
    );
  }
  effect(
    effect: SessionEffect,
    parent: string,
    publication?: PublicationAttempt,
  ) {
    const connection = this.sessions.get(effect.session);
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
      connection.closedBy = closed;
      this.discard(connection, closed);
      return;
    }
    const envelope = parseJson(effect.wire);
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
    const lossCause =
      effect.kind === "receipt" && publication
        ? this.receiptLoss(connection, publication, messageId, sent)
        : undefined;
    const latency = this.latencies.get(connection.actor)!;
    if (latency > 0) {
      this.links.send(
        connection,
        effect.kind === "receipt" ? "source-receipt" : "client-frame",
        envelope,
        messageId,
        latency,
        sent,
        async (arrival) => {
          this.observations.get(connection.actor)!.push(envelope);
          if (effect.kind === "receipt" && publication)
            this.ports.receipt(
              publication.action,
              publication.attempt,
              connection.generation,
              arrival,
            );
        },
        lossCause,
      );
      return;
    }
    this.messages++;
    this.messageBound();
    const task =
      this.scenario.document.format === "timeline-simulation/v2"
        ? this.agenda.allocateModelTask()
        : undefined;
    if (task !== undefined)
      this.queued.set(task, {
        connection,
        cancel: (cause) => {
          this.messages--;
          this.event(
            "dropped",
            {
              ...(j({
                messageId,
                channel:
                  effect.kind === "receipt" ? "source-receipt" : "client-frame",
                reason: "connection-closed",
              }) as { [key: string]: Json }),
              envelope,
            },
            cause,
            connection,
            [sent, ...(lossCause ? [lossCause] : [])],
          );
        },
      });
    this.agenda.add(
      this.agenda.current[0],
      2,
      async () => {
        if (task !== undefined) this.queued.delete(task);
        this.ports.consumeExecutionTurn();
        this.messages--;
        const delivered = connection.open && !lossCause;
        const arrival = this.event(
          delivered ? "delivered" : "dropped",
          {
            ...(j({
              messageId,
              channel:
                effect.kind === "receipt" ? "source-receipt" : "client-frame",
              ...(delivered
                ? {}
                : { reason: lossCause ? "receipt-loss" : "connection-closed" }),
            }) as { [key: string]: Json }),
            envelope,
          },
          sent,
          connection,
          lossCause
            ? [lossCause]
            : !delivered && connection.closedBy
              ? [connection.closedBy]
              : [],
        );
        if (delivered) {
          this.observations.get(connection.actor)!.push(envelope);
          if (effect.kind === "receipt" && publication)
            this.ports.receipt(
              publication.action,
              publication.attempt,
              connection.generation,
              arrival,
            );
        }
      },
      task,
    );
  }
  private discard(connection: Connection, cause: string) {
    this.links.close(connection, cause);
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
        cause,
        connection,
        [held.id],
      );
      this.handoffs.delete(connection.session);
    }
  }
  stop(cause: string) {
    for (const connection of this.sessions.values()) {
      connection.open = false;
      connection.attached = false;
      connection.closedBy = cause;
      this.discard(connection, cause);
    }
    for (const [id, pending] of this.queued) {
      this.agenda.cancel(id);
      pending.cancel(cause);
    }
    this.queued.clear();
    this.sessions.clear();
    for (const id of this.faultTasks.values()) this.agenda.cancel(id);
    this.faultTasks.clear();
    this.pendingFaultCloses.clear();
  }
  private receiptLoss(
    connection: Connection,
    publication: PublicationAttempt,
    messageId: string,
    sent: string,
  ): string | undefined {
    let lossCause: string | undefined;
    const rule = this.rules.find((rule) => rule.action === publication.action);
    if (rule) {
      for (let drawIndex = 0; ; drawIndex++) {
        if (drawIndex === 16)
          throw new Error("limit-exceeded: receipt-loss draws");
        const draw = receiptDraw(
          {
            seed: text(this.scenario.document.seed, "seed"),
            scenario: text(this.scenario.document.id, "id"),
            rule: rule.id,
            actor: connection.actor,
            action: publication.action,
            generation: connection.generation,
            attempt: publication.attempt,
          },
          rule.numerator,
          rule.denominator,
          drawIndex,
        );
        const decision = this.event(
          "fault-decision",
          j({
            ...draw,
            ruleId: rule.id,
            actionId: publication.action,
            messageId,
            attempt: publication.attempt,
          }),
          sent,
          connection,
        );
        if (!draw.rejected) {
          if (draw.lost) {
            lossCause = decision;
            this.closeForReceiptLoss(connection, messageId, decision);
          }
          break;
        }
      }
    }
    return lossCause;
  }
  private closeForReceiptLoss(
    connection: Connection,
    messageId: string,
    decision: string,
  ) {
    if (this.pendingFaultCloses.has(connection.session)) return;
    this.pendingFaultCloses.add(connection.session);
    const task =
      this.scenario.document.format === "timeline-simulation/v2"
        ? this.agenda.allocateModelTask()
        : undefined;
    if (task !== undefined) this.faultTasks.set(connection.session, task);
    this.agenda.add(
      this.agenda.current[0],
      0,
      async () => {
        this.pendingFaultCloses.delete(connection.session);
        this.faultTasks.delete(connection.session);
        if (!connection.attached) return;
        const cause = this.event(
          "runtime-command",
          j({ op: "disconnect", reason: "receipt-loss", messageId }),
          decision,
          connection,
        );
        await this.ports.command(
          { op: "disconnect", session: connection.session },
          cause,
        );
        connection.open = false;
        connection.attached = false;
      },
      task,
    );
  }
  async sendToRuntime(
    connection: Connection,
    operation: Record<string, unknown>,
    cause: string,
    publication?: PublicationAttempt,
  ) {
    const latency = this.latencies.get(connection.actor)!;
    if (latency === 0) {
      await this.ports.command(operation, cause, publication);
      return;
    }
    const channel: LinkChannel =
      operation.op === "ingress" ? "source-publication" : "client-request";
    this.links.send(
      connection,
      channel,
      parseJson(String(operation.wire)),
      `message-${this.messageSequence++}`,
      latency,
      cause,
      (arrival) => this.ports.command(operation, arrival, publication),
    );
  }
}
