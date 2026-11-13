import assert from "node:assert/strict";
import type { Agenda } from "./agenda.js";
import type { Bridge, Effect, Response } from "./bridge.js";
import { parseJson, type Json } from "./json.js";
import { SemanticTrace, metadataJson as j } from "./semantic-trace.js";

export type PublicationAttempt = { action: string; attempt: number };

/** Owns the global execution budget, acknowledged runtime commands and host tasks. */
export class RuntimeTurns {
  last?: Response;
  private turns = 0;
  private readonly tasks = new Map<number, string>();
  constructor(
    private readonly bridge: Bridge,
    private readonly agenda: Agenda,
    private readonly trace: SemanticTrace,
    private readonly turnLimit: number,
    private readonly sessionEffect: (
      effect: Effect,
      parent: string,
      publication?: PublicationAttempt,
    ) => void,
  ) {}
  consumeExecutionTurn() {
    if (++this.turns > this.turnLimit)
      throw new Error("limit-exceeded: execution turns");
  }
  private event(
    kind: string,
    data: Json,
    parent: string,
    causes: string[] = [],
  ) {
    return this.trace.event(
      kind,
      this.agenda.current,
      "@runtime",
      null,
      parent,
      data,
      causes,
    );
  }
  async command(
    operation: Record<string, unknown>,
    parent: string,
    publication?: PublicationAttempt,
  ) {
    this.consumeExecutionTurn();
    const response = await this.bridge.command(
      this.agenda.current[0],
      operation,
    );
    this.last = response;
    for (const effect of response.effects)
      this.effect(effect, parent, publication);
  }
  private effect(
    effect: Effect,
    parent: string,
    publication?: PublicationAttempt,
  ) {
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
      this.event("cancelled", j({ taskId: String(effect.task) }), parent, [
        owner,
      ]);
      this.tasks.delete(effect.task!);
      this.agenda.cancel(effect.task!);
      return;
    }
    if (effect.kind === "state") {
      this.event("state", { envelope: parseJson(effect.wire!) }, parent);
      return;
    }
    this.sessionEffect(effect, parent, publication);
  }
  checkPending() {
    assert.equal(
      this.tasks.size,
      this.last?.pendingTasks ?? 0,
      "runtime/agenda pending-task accounting",
    );
  }
}
