import { observationTarget, type ObservationTarget } from "./envelopes.js";
import { isRuntimeAction } from "./event-schema.js";
import { encodeJson, type Json } from "./json.js";
import { integer, invalid, list, object, text } from "./validation.js";

type Event = {
  kind: string;
  id: string;
  parent: string | null;
  causes: string[];
  actor: string;
  timeMs: number;
  key: readonly number[];
  runtimeGeneration: number | null;
  connectionGeneration: number | null;
  data: { [key: string]: Json };
};

const sessionKinds = new Set([
  "frame",
  "receipt",
  "handoff",
  "delivered",
  "dropped",
  "link-send",
  "connection-closed",
  "fault-decision",
  "retry-lifecycle",
]);

/** Checks v2 runtime, connection and task identities in trace order. */
export class TraceGenerations {
  private generation = 0;
  private active: number | null = null;
  private epoch?: number;
  private wallOffset = 0;
  private starting?: Event;
  private stop?: Event;
  private readonly tasks = new Map<string, Event>();
  private readonly stopClosures = new Set<string>();
  private readonly attemptParents = new Map<string, Event>();
  private readonly connections = new Map<string, number[]>();
  private observedTargets?: string[];
  private pendingObservation?: Event;

  constructor(
    private readonly untilMs: number,
    targets?: readonly ObservationTarget[],
  ) {
    this.observedTargets = targets?.map(targetKey);
  }

  accept(event: Event, path: string) {
    const {
      kind,
      id,
      parent,
      causes,
      actor,
      runtimeGeneration,
      connectionGeneration,
      data,
    } = event;
    if (this.epoch !== undefined) this.wallMillis(event.timeMs, path);
    const snapshotAssertion =
      kind === "assertion" && data.assertionKind === "runtime-snapshot";
    if (this.pendingObservation && !snapshotAssertion)
      invalid(
        path,
        "runtime observation must be immediately followed by its assertion",
      );
    if (this.starting && kind !== "runtime-initialized")
      invalid(
        path,
        "runtime start must be immediately followed by initialization",
      );

    if (kind === "runtime-initialized") {
      if (
        actor !== "@runtime" ||
        connectionGeneration !== null ||
        this.active !== null ||
        runtimeGeneration !== this.generation + 1
      )
        invalid(path, "initialization must open the next runtime generation");
      if (this.generation === 0 && event.timeMs !== 0)
        invalid(path, "initial runtime generation must start at time zero");
      if (
        !this.starting ||
        parent !== this.starting.id ||
        !sameKey(event.key, this.starting.key)
      )
        invalid(
          path,
          "initialization must identify its start at the same agenda key",
        );
      if (
        this.epoch === undefined ||
        integer(data.wallMillis, `${path}.data.wallMillis`) !==
          this.wallMillis(event.timeMs, path)
      )
        invalid(
          path,
          "initialization wall clock must equal epoch plus global time and the declared wall offset",
        );
      if (
        [...this.tasks.values()].some((task) => isRuntimeTask(task.data.taskId))
      )
        invalid(
          path,
          "initialization cannot retain an old generation's runtime tasks",
        );
      const snapshots = list(data.snapshots, `${path}.data.snapshots`, 64);
      const targets = snapshots.map((value, index) => {
        const snapshotPath = `${path}.data.snapshots[${index}]`;
        return targetKey(
          observationTarget(object(value, snapshotPath), snapshotPath),
        );
      });
      if (
        this.observedTargets &&
        (targets.length !== this.observedTargets.length ||
          targets.some((key, index) => key !== this.observedTargets![index]))
      )
        invalid(
          path,
          "initialization snapshots must match declared observation target order",
        );
      this.observedTargets = targets;
      this.generation = runtimeGeneration;
      this.active = runtimeGeneration;
      this.starting = undefined;
      this.stop = undefined;
      return;
    }

    const stoppingEffect =
      this.stop !== undefined &&
      event.timeMs === this.stop.timeMs &&
      ((parent === this.stop.id &&
        ["cancelled", "dropped", "connection-closed"].includes(kind)) ||
        (kind === "dropped" &&
          parent !== null &&
          this.stopClosures.has(parent)));
    const task =
      kind === "scheduled" ||
      kind === "task-dispatched" ||
      kind === "cancelled";
    const external =
      kind === "retry-status" ||
      (task && typeof data.taskId === "string" && data.taskId.startsWith("-"));
    const expectedGeneration = external
      ? null
      : stoppingEffect
        ? this.stop!.runtimeGeneration
        : this.active;
    if (runtimeGeneration !== expectedGeneration)
      invalid(path, "runtime generation does not match availability");
    if (external && connectionGeneration !== null)
      invalid(
        path,
        "external retry records cannot identify a runtime connection",
      );
    this.connection(event, path);
    if (stoppingEffect && kind === "connection-closed") {
      if (this.stop!.data.mode === "abrupt")
        invalid(path, "abrupt stops cannot emit a host close callback");
      this.stopClosures.add(id);
    }

    if (kind === "runtime-command" && data.op === "initialize-document") {
      if (
        this.generation !== 0 ||
        this.starting ||
        actor !== "@runtime" ||
        connectionGeneration !== null ||
        parent !== null ||
        causes.length > 0 ||
        event.key[1] !== 0 ||
        event.key[2] !== 0 ||
        event.timeMs !== 0
      )
        invalid(
          path,
          "initial command must belong to the unstarted runtime at time zero",
        );
      this.epoch = integer(data.epochMillis, `${path}.data.epochMillis`);
      if (!Number.isSafeInteger(this.epoch + this.untilMs))
        invalid(path, "epoch plus horizon overflows safe integer");
      this.starting = event;
    }

    if (kind === "action") {
      if (
        data.actionKind === "connect" ||
        data.actionKind === "source-send" ||
        data.actionKind === "source-retry"
      )
        this.attemptParents.set(id, event);
      if (
        typeof data.actionKind === "string" &&
        isRuntimeAction(data.actionKind) &&
        (actor !== "@runtime" ||
          connectionGeneration !== null ||
          parent !== null ||
          causes.length > 0 ||
          event.key[1] !== 0 ||
          event.key[2] !== 0)
      )
        invalid(
          path,
          "runtime control must be a declared round-zero phase-zero root action",
        );
      if (data.actionKind === "wall-clock-set") {
        if (this.generation === 0 || (runtimeGeneration === null && !this.stop))
          invalid(
            path,
            "wall-clock-set requires an initialized or stopped runtime",
          );
        this.wallOffset =
          integer(data.wallMillis, `${path}.data.wallMillis`) -
          (this.epoch! + event.timeMs);
      } else if (
        data.actionKind === "service-stop" ||
        data.actionKind === "service-start"
      ) {
        if (data.actionKind === "service-stop") {
          if (this.active === null)
            invalid(path, "cannot stop an unavailable runtime");
          this.active = null;
          this.stop = event;
          this.stopClosures.clear();
        } else {
          if (this.active !== null || !this.stop)
            invalid(path, "service start requires a stopped runtime");
          this.starting = event;
        }
      }
    } else if (kind === "retry-attempt") {
      this.attemptParents.set(id, event);
    } else if (kind === "connection-outcome" || kind === "attempt-outcome") {
      if (
        runtimeGeneration !== null ||
        connectionGeneration !== null ||
        parent === null ||
        !this.stop ||
        !causes.includes(this.stop.id)
      )
        invalid(
          path,
          "unavailable outcomes require a parent and the current stop cause",
        );
      const attempt = this.attemptParents.get(parent);
      if (
        !attempt ||
        attempt.actor !== actor ||
        attempt.timeMs !== event.timeMs ||
        (kind === "connection-outcome"
          ? attempt.data.actionKind !== "connect"
          : attempt.data.publication !== data.publication)
      )
        invalid(
          path,
          "unavailable outcome must identify its actor's attempted action or retry",
        );
    } else if (kind === "runtime-observation") {
      if (
        actor !== "@runtime" ||
        connectionGeneration !== null ||
        parent !== null
      )
        invalid(
          path,
          "runtime observations require a runtime actor and no connection or parent",
        );
      if (runtimeGeneration === null) {
        if (
          data.outcome !== "runtime-unavailable" ||
          !this.stop ||
          !causes.includes(this.stop.id)
        )
          invalid(
            path,
            "unavailable runtime observation requires the current stop cause",
          );
      } else if (data.outcome !== "available") {
        invalid(
          path,
          "running runtime observation requires an installed snapshot",
        );
      }
      const target = targetKey(observationTarget(data, `${path}.data`));
      if (!this.observedTargets?.includes(target))
        invalid(path, "runtime observation requires a declared target");
      this.pendingObservation = event;
    } else if (snapshotAssertion) {
      const observation = this.pendingObservation;
      if (
        actor !== "@runtime" ||
        connectionGeneration !== null ||
        !observation ||
        observation.id !== parent ||
        observation.runtimeGeneration !== runtimeGeneration ||
        observation.data.viewId !== data.viewId ||
        observation.data.entityId !== data.entityId
      )
        invalid(
          path,
          "runtime snapshot assertion must identify its matching observation",
        );
      if (!sameKey(event.key, observation.key))
        invalid(
          path,
          "runtime snapshot assertion must share its observation's same agenda key",
        );
      const { outcome, snapshot } = observation.data;
      const observed = {
        outcome,
        ...(snapshot !== undefined ? { snapshot } : {}),
      };
      if (encodeJson(data.actual) !== encodeJson(observed))
        invalid(
          path,
          "runtime snapshot assertion actual differs from its observation",
        );
      this.pendingObservation = undefined;
    } else if (task) {
      this.task(event, path);
    } else if (
      kind === "assertion" &&
      runtimeGeneration === null &&
      connectionGeneration !== null
    ) {
      invalid(path, "downtime assertions cannot identify a live connection");
    } else if (kind === "state" && runtimeGeneration === null) {
      invalid(path, "runtime state effects require an active generation");
    }
  }

  private connection(event: Event, path: string) {
    const { kind, actor, runtimeGeneration, connectionGeneration, data } =
      event;
    const declaredConnect = kind === "action" && data.actionKind === "connect";
    const retryConnect =
      kind === "retry-lifecycle" && data.operation === "connect";
    const requiresConnection =
      sessionKinds.has(kind) ||
      (kind === "retry-attempt" && runtimeGeneration !== null);
    if (
      requiresConnection &&
      (runtimeGeneration === null || connectionGeneration === null)
    )
      invalid(path, "session-bound event requires a connection identity");
    const history = this.connections.get(actor);
    if ((declaredConnect && runtimeGeneration !== null) || retryConnect) {
      if (
        actor === "@runtime" ||
        runtimeGeneration === null ||
        connectionGeneration !== (history?.length ?? 0) + 1
      )
        invalid(
          path,
          "connect must introduce the actor's next connection generation",
        );
      if (history) history.push(runtimeGeneration);
      else this.connections.set(actor, [runtimeGeneration]);
    } else if (
      connectionGeneration !== null &&
      history?.[connectionGeneration - 1] !== runtimeGeneration
    ) {
      invalid(
        path,
        "connection identity does not belong to this runtime generation",
      );
    }
  }

  finish(outcome: string) {
    // A trace bound can stop emission between the observation and its assertion.
    if (
      this.pendingObservation &&
      outcome !== "limit-exceeded" &&
      outcome !== "infrastructure-failed"
    )
      invalid("trace result", "trace has an unasserted runtime observation");
    if (
      this.starting &&
      outcome !== "limit-exceeded" &&
      outcome !== "infrastructure-failed"
    )
      invalid(
        "trace result",
        "trace requires completed runtime initialization after start",
      );
    if (outcome !== "passed") return this.epoch;
    if (this.generation === 0)
      invalid(
        "trace result",
        "passing trace requires completed runtime initialization",
      );
    this.wallMillis(this.untilMs, "trace result");
    if (
      this.active === null &&
      [...this.tasks.values()].some((task) => isRuntimeTask(task.data.taskId))
    )
      invalid(
        "trace result",
        "a stopped runtime cannot retain generation tasks",
      );
    return this.epoch;
  }

  private wallMillis(atMs: number, path: string) {
    if (this.epoch === undefined)
      invalid(path, "runtime wall clock has no epoch");
    const value = this.epoch + atMs + this.wallOffset;
    if (!Number.isSafeInteger(value) || value < 0)
      invalid(path, "runtime wall clock is outside the safe integer range");
    return value;
  }

  private task(event: Event, path: string) {
    const taskId = text(event.data.taskId, `${path}.data.taskId`);
    if (
      !/^-?[1-9][0-9]*$/.test(taskId) ||
      !Number.isSafeInteger(Number(taskId))
    )
      invalid(path, "expected nonzero safe integer task identity");
    if (isRuntimeTask(taskId) && event.runtimeGeneration === null)
      invalid(path, "runtime tasks require a generation");
    const key = isRuntimeTask(taskId)
      ? `${event.runtimeGeneration}:${taskId}`
      : taskId;
    const scheduled = this.tasks.get(key);
    if (event.kind === "scheduled") {
      if (scheduled) invalid(path, "task is already scheduled");
      this.tasks.set(key, event);
      return;
    }
    if (!scheduled)
      invalid(path, "task has no pending schedule in its generation");
    if (event.kind === "task-dispatched") {
      if (
        event.parent !== scheduled.id ||
        event.timeMs !== integer(scheduled.data.atMs, path)
      )
        invalid(path, "dispatch must name its schedule at the due time");
    } else if (!event.causes.includes(scheduled.id)) {
      invalid(path, "cancellation must cite its schedule");
    }
    this.tasks.delete(key);
  }
}

function targetKey({ viewId, entityId }: ObservationTarget) {
  return JSON.stringify([viewId, entityId]);
}

function isRuntimeTask(taskId: Json | undefined) {
  return typeof taskId === "string" && !taskId.startsWith("-");
}

function sameKey(left: readonly number[], right: readonly number[]) {
  return left.every((coordinate, index) => coordinate === right[index]);
}
