import assert from "node:assert/strict";
import { Agenda } from "./agenda.js";
import type { Bridge } from "./bridge.js";
import type { TimelineDocument } from "./contract.js";
import { DocumentTransport } from "./document-transport.js";
import { RuntimeTurns } from "./runtime-turns.js";
import { DocumentActors } from "./document-actors.js";
import { RuntimeGenerations } from "./runtime-generations.js";
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
  private readonly actors: DocumentActors;
  constructor(
    readonly bridge: Bridge | RuntimeGenerations,
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
          this.actors.retries.receipt(action, attempt, generation, parent),
      },
    );
    this.actors = new DocumentActors(
      this.agenda,
      this.runtime,
      this.transport,
      scenario,
      trace,
    );
  }
  private event(kind: string, data: Json, parent: string | null) {
    return this.trace.event(
      kind,
      this.agenda.current,
      "@runtime",
      null,
      parent,
      data,
      [],
      this.runtime.generation,
    );
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
    if (this.runtime.lifecycle) await this.runtime.start(cause);
    else
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
          if (
            action.kind === "service-start" ||
            action.kind === "service-stop"
          ) {
            this.runtime.consumeExecutionTurn();
            const cause = this.event(
              "action",
              j({
                actionId: action.id,
                actionKind: action.kind,
                ...(action.kind === "service-stop"
                  ? { mode: action.mode }
                  : {}),
              }),
              null,
            );
            if (action.kind === "service-start")
              await this.runtime.start(cause);
            else {
              await this.runtime.stop(
                cause,
                action.mode as "orderly" | "abrupt",
              );
              this.transport.stop(cause);
              this.actors.stopped(cause);
            }
          } else await this.actors.action(admitted, action);
        },
        undefined,
        true,
      );
    }
  }
  async settle(at: number) {
    await this.agenda.through(at);
    if (!this.runtime.available) return;
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
    const connection = this.actors.connection(actor);
    this.trace.event(
      "assertion",
      this.agenda.current,
      actor,
      this.runtime.lifecycle &&
        connection?.runtimeGeneration !== this.runtime.generation
        ? null
        : (connection?.generation ?? null),
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
      [],
      this.runtime.generation,
    );
    if (!passed)
      throw new Error(`assertion-failed: ${text(assertion.id, "id")}`);
  }
  counts(): Counts {
    return {
      pendingFutureTasks:
        (this.runtime.last?.pendingTasks ?? 0) + this.actors.retries.pending(),
      pendingMessages: this.transport.pending(),
      heldFrames: this.runtime.last?.heldFrames ?? 0,
    };
  }
  checkEnd() {
    const end = object(this.scenario.document.end, "end");
    const counts = this.counts();
    this.runtime.checkPending();
    if (this.actors.retries.unfinished())
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
      if (this.runtime.lifecycle && !this.runtime.available) return;
      const cause = this.event("runtime-command", j({ op: "shutdown" }), null);
      if (this.runtime.lifecycle) {
        if (this.runtime.available) {
          await this.runtime.stop(cause, "orderly");
          this.transport.stop(cause);
          this.actors.stopped(cause);
        }
      } else await this.runtime.command({ op: "shutdown" }, cause);
    });
    await this.agenda.through(this.agenda.current[0]);
    assert.equal(
      this.agenda.pending().length,
      0,
      "shutdown leaves no model work",
    );
  }
}
