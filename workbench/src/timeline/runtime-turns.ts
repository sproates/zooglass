import assert from "node:assert/strict";
import type { Agenda } from "./agenda.js";
import type { Bridge, Effect, Response, SessionEffect } from "./bridge.js";
import { RuntimeGenerations } from "./runtime-generations.js";
import { installedSnapshot, type ObservationTarget } from "./envelopes.js";
import { parseJson, type Json } from "./json.js";
import { SemanticTrace, metadataJson as j } from "./semantic-trace.js";
import { object } from "./validation.js";

export type PublicationAttempt = { action: string; attempt: number };

/** Owns the global execution budget, acknowledged runtime commands and host tasks. */
export class RuntimeTurns {
  last?: Response;
  private turns = 0;
  private readonly tasks = new Map<
    string,
    { event: string; agendaId: number; generation: number; task: number }
  >();
  constructor(
    private readonly bridge: Bridge | RuntimeGenerations,
    private readonly agenda: Agenda,
    private readonly trace: SemanticTrace,
    private readonly turnLimit: number,
    private readonly sessionEffect: (
      effect: SessionEffect,
      parent: string,
      publication?: PublicationAttempt,
    ) => void,
    private readonly observationTargets: readonly ObservationTarget[] = [],
  ) {}
  get lifecycle() {
    return this.bridge instanceof RuntimeGenerations;
  }
  get generation(): number | null {
    return this.bridge instanceof RuntimeGenerations
      ? (this.bridge.current?.number ?? null)
      : 1;
  }
  get available() {
    return this.generation !== null;
  }
  async start(parent: string) {
    assert.ok(this.bridge instanceof RuntimeGenerations);
    this.consumeExecutionTurn();
    const response = await this.bridge.start(this.agenda.current[0]);
    const snapshots = response.snapshots ?? [];
    assert.equal(
      snapshots.length,
      this.observationTargets.length,
      "initialized snapshots match the count of declared observation targets",
    );
    const initialized = this.event(
      "runtime-initialized",
      {
        ...object(
          j({
            startTimeMs: response.timeMs,
            wallMillis: response.wallMillis,
            monotonicMs: response.monotonicMs,
          }),
          "runtime initialization",
        ),
        snapshots: snapshots.map((wire, index) =>
          installedSnapshot(
            parseJson(wire),
            `initialized snapshot[${index}]`,
            this.observationTargets[index],
          ),
        ),
      },
      parent,
      [],
      response.runtimeGeneration,
    );
    this.accept(response, initialized);
  }
  async observeInstalled(target: ObservationTarget) {
    assert.ok(this.bridge instanceof RuntimeGenerations && this.bridge.current);
    this.consumeExecutionTurn();
    const response = await this.bridge.command(
      this.bridge.current,
      this.agenda.current[0],
      {
        op: "observe-installed",
        observationTargets: [target],
      },
    );
    assert.deepEqual(
      response.effects,
      [],
      "installed observation must not emit runtime effects",
    );
    assert.equal(
      response.pendingTasks,
      this.last?.pendingTasks ?? 0,
      "installed observation must not change pending tasks",
    );
    assert.equal(
      response.heldFrames,
      this.last?.heldFrames ?? 0,
      "installed observation must not change held frames",
    );
    assert.equal(
      response.snapshots?.length,
      1,
      "installed observation returns its sole target",
    );
    return installedSnapshot(
      parseJson(response.snapshots![0]),
      "installed snapshot",
      target,
    );
  }
  async setWall(wallMillis: number) {
    assert.ok(this.bridge instanceof RuntimeGenerations);
    this.consumeExecutionTurn();
    const response = await this.bridge.setWall(
      this.agenda.current[0],
      wallMillis,
    );
    if (response) this.last = response;
  }

  async stop(parent: string, mode: "orderly" | "abrupt") {
    assert.ok(this.bridge instanceof RuntimeGenerations && this.bridge.current);
    this.consumeExecutionTurn();
    const generation = this.bridge.current.number;
    const response = await this.bridge.stop(
      this.bridge.current,
      this.agenda.current[0],
      mode,
    );
    if (response) this.accept(response, parent);
    for (const [key, task] of this.tasks) {
      this.event(
        "cancelled",
        j({ taskId: String(task.task) }),
        parent,
        [task.event],
        generation,
      );
      this.agenda.cancel(task.agendaId);
      this.tasks.delete(key);
    }
    this.last = undefined;
  }
  private accept(
    response: Response,
    parent: string,
    publication?: PublicationAttempt,
  ) {
    this.last = response;
    for (const effect of response.effects)
      this.effect(effect, parent, response.runtimeGeneration, publication);
  }
  consumeExecutionTurn() {
    if (++this.turns > this.turnLimit)
      throw new Error("limit-exceeded: execution turns");
  }
  private event(
    kind: string,
    data: Json,
    parent: string,
    causes: string[] = [],
    generation = this.generation,
  ) {
    return this.trace.event(
      kind,
      this.agenda.current,
      "@runtime",
      null,
      parent,
      data,
      causes,
      generation,
    );
  }
  async command(
    operation: Record<string, unknown>,
    parent: string,
    publication?: PublicationAttempt,
  ) {
    this.consumeExecutionTurn();
    const response =
      this.bridge instanceof RuntimeGenerations
        ? await this.bridge.command(
            this.bridge.current!,
            this.agenda.current[0],
            operation,
          )
        : await this.bridge.command(this.agenda.current[0], operation);
    this.accept(response, parent, publication);
  }

  private effect(
    effect: Effect,
    parent: string,
    generation: number,
    publication?: PublicationAttempt,
  ) {
    if (effect.kind === "schedule") {
      const key = `${generation}:${effect.task}`;
      assert.ok(!this.tasks.has(key), "scheduled task has a unique owner");
      assert.ok(
        effect.at >= this.agenda.current[0],
        "runtime task cannot be scheduled in the past",
      );
      const id = this.event(
        "scheduled",
        j({
          taskId: String(effect.task),
          atMs: effect.at,
          phase: effect.phase,
          taskKind: effect.taskKind,
        }),
        parent,
        [],
        generation,
      );
      const agendaId = this.lifecycle
        ? this.agenda.allocateModelTask()
        : effect.task;
      this.tasks.set(key, {
        event: id,
        agendaId,
        generation,
        task: effect.task,
      });
      this.agenda.add(
        effect.at,
        effect.phase,
        async () => {
          assert.equal(
            this.tasks.get(key)?.event,
            id,
            "task retains its scheduling owner",
          );
          this.tasks.delete(key);
          assert.equal(
            this.generation,
            generation,
            "task belongs to active runtime generation",
          );
          const dispatch = this.event(
            "task-dispatched",
            j({ taskId: String(effect.task) }),
            id,
          );
          await this.command({ op: "task", task: effect.task }, dispatch);
        },
        agendaId,
      );
      return;
    }
    if (effect.kind === "cancel") {
      const key = `${generation}:${effect.task}`;
      const owner = this.tasks.get(key);
      assert.ok(owner, "cancellation identifies a pending scheduled task");
      this.event(
        "cancelled",
        j({ taskId: String(effect.task) }),
        parent,
        [owner.event],
        generation,
      );
      this.tasks.delete(key);
      this.agenda.cancel(owner.agendaId);
      return;
    }
    if (effect.kind === "state") {
      this.event(
        "state",
        { envelope: parseJson(effect.wire) },
        parent,
        [],
        generation,
      );
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
