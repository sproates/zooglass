import type { Response } from "./host-protocol.js";

type CommandState = Readonly<{
  epoch: number;
  turnId: number;
  wallOffset: number;
  wallClockAdjustments: 0 | 1;
  generation?: Readonly<{ runtimeGeneration: number; startTimeMs: number }>;
}>;

/** Derive clocks and encode a command without advancing bridge state. */
export function prepareCommand(
  timeMs: number,
  operation: Record<string, unknown>,
  state: CommandState,
  cap: number,
) {
  let commandEpoch = state.epoch;
  if (operation.op === "initialize-document") {
    if (
      !Number.isSafeInteger(operation.epochMillis) ||
      Number(operation.epochMillis) < 0
    )
      throw new Error("Invalid document epoch");
    commandEpoch = Number(operation.epochMillis);
  }
  const turnId = state.turnId;
  const runtimeGeneration = state.generation?.runtimeGeneration ?? 1;
  const monotonicMs = state.generation
    ? timeMs - state.generation.startTimeMs
    : timeMs;
  const baseWall = commandEpoch + timeMs;
  let offset = state.wallOffset;
  if (
    operation.op === "initialize-document" &&
    operation.wallOffsetMillis !== undefined
  ) {
    if (
      !state.generation ||
      state.wallClockAdjustments !== 1 ||
      !Number.isSafeInteger(operation.wallOffsetMillis)
    )
      throw new Error("Unsupported or invalid initial wall offset");
    offset = Number(operation.wallOffsetMillis);
  }
  if (operation.op === "wall-clock-set") {
    if (
      !state.generation ||
      state.wallClockAdjustments !== 1 ||
      !Number.isSafeInteger(operation.wallMillis) ||
      Number(operation.wallMillis) < 0
    )
      throw new Error("Unsupported or invalid wall adjustment");
    offset = Number(operation.wallMillis) - baseWall;
  }
  const wallMillis = baseWall + offset;
  if (
    state.generation &&
    (!Number.isSafeInteger(baseWall) ||
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(wallMillis) ||
      wallMillis < 0)
  )
    throw new Error("Invalid generation wall clock");
  const bytes = Buffer.from(
    JSON.stringify({
      ...operation,
      ...(state.generation && operation.op === "initialize-document"
        ? { startTimeMs: state.generation.startTimeMs }
        : {}),
      turnId,
      runtimeGeneration,
      timeMs,
      monotonicMs,
      wallMillis,
    }),
  );
  if (bytes.length > cap) {
    throw new Error("Command frame overflow");
  }

  return {
    operation,
    timeMs,
    turnId,
    runtimeGeneration,
    monotonicMs,
    wallMillis,
    epoch: commandEpoch,
    wallOffset: offset,
    generation: state.generation,
    bytes,
  };
}

type PreparedCommand = ReturnType<typeof prepareCommand>;

/** Validate the complete reply before the bridge commits acknowledgment state. */
export function validateCommandResponse(
  value: Response,
  command: PreparedCommand,
  projectedObservations: boolean,
): boolean {
  const {
    operation,
    turnId,
    runtimeGeneration,
    timeMs,
    monotonicMs,
    wallMillis,
  } = command;
  if (
    value.turnId !== turnId ||
    value.runtimeGeneration !== runtimeGeneration ||
    value.timeMs !== timeMs
  )
    throw new Error("Mismatched turn response");
  if (
    command.generation &&
    (value.monotonicMs !== monotonicMs || value.wallMillis !== wallMillis)
  )
    throw new Error("Mismatched generation response clocks");
  const targets =
    operation.op === "initialize-document" ||
    operation.op === "observe-installed"
      ? operation.observationTargets
      : undefined;
  if (targets !== undefined) {
    if (!Array.isArray(targets) || value.snapshots?.length !== targets.length)
      throw new Error("Mismatched initialization snapshots");
  } else if (value.snapshots !== undefined) {
    throw new Error("Unrequested initialization snapshots");
  }
  const projected =
    operation.op === "initialize-document"
      ? operation.profile === "memory-static-views-v1"
      : projectedObservations;
  if (
    (value.projectedSnapshots !== undefined) !==
    (targets !== undefined && projected)
  )
    throw new Error("Mismatched public snapshot projection");
  return projected;
}
