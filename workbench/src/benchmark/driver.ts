import {
  setTimeout as delay,
  setImmediate as yieldTurn,
} from "node:timers/promises";
import type WebSocket from "ws";
import { startZooGlassSession } from "../service/zooglass-session.js";
import { BenchmarkOracle } from "./oracle.js";
import {
  BenchmarkLimit,
  type BenchmarkPublication,
  type BenchmarkPhase,
} from "./model.js";
import { Connections } from "./connections.js";
import { Schedule, driveWindows, scheduleWindows } from "./schedule.js";
import { Workload, type WorkloadOptions } from "./workload.js";

export interface DriverOptions {
  workload: WorkloadOptions;
  rate: number;
  warmupMs: number;
  measurementMs: number;
  drainMs: number;
  serviceDirectory?: string;
  signal?: AbortSignal;
  databasePath?: string;
  inheritedLockFd?: number;
  javaOptions?: string[];
  onReady?: (pid: number) => void;
  onBoundary?: (
    phase: "before-warmup" | "measurement-start" | "measurement-end",
  ) => Promise<void>;
}

/** One execution only. Campaign selection, sampling and capacity classification are separate. */
export async function runDriver(options: DriverOptions) {
  const workload = new Workload(options.workload);
  const warmup = new Schedule(options.rate, options.warmupMs);
  const measurement = new Schedule(options.rate, options.measurementMs);
  if (
    !Number.isSafeInteger(options.drainMs) ||
    options.drainMs < 1 ||
    options.drainMs > 10000
  )
    throw new Error("Invalid drain deadline");
  const oracle = new BenchmarkOracle({
    storage: options.workload.storage,
    viewIds: workload.viewIds,
    viewerIds: workload.viewerIds,
  });
  const session = await startZooGlassSession({
    configuration: workload.configuration,
    serviceDirectory: options.serviceDirectory,
    signal: options.signal,
    startupTimeoutMs: 300000,
    databasePath: options.databasePath,
    inheritedLockFd: options.inheritedLockFd,
    javaOptions: options.javaOptions,
  });
  const connections = new Connections(session.signal);
  const sources: WebSocket[] = [];
  const latest = new Map<string, BenchmarkPublication>();
  const windows = scheduleWindows(warmup, measurement);
  let drainEnd = Infinity;
  const checkArrival = (atMs: number) => {
    if (atMs > drainEnd) {
      throw new Error("Benchmark observation deadline exceeded");
    }
  };
  let error: string | undefined;
  let cleanupError: string | undefined;
  let errorKind:
    "harness-limited" | "correctness" | "service-budget" | undefined;
  let finalSnapshots = 0;
  let maxBufferedBytes = 0;
  let maxPending = 0;
  const wireBytes = {
    sentEnvelopes: 0,
    receivedReceipts: 0,
    receivedViewFrames: 0,
    envelopes: 0,
    receipts: 0,
    viewFrames: 0,
  };
  const phaseTimes: Record<string, number> = { readyMs: performance.now() };
  const wait = async (ready: () => boolean, deadlineMs: number) => {
    const until = performance.now() + deadlineMs;
    while (!ready()) {
      connections.check();
      if (performance.now() >= until)
        throw new Error("Benchmark observation deadline exceeded");
      await delay(2, undefined, { signal: session.signal });
    }
    connections.check();
  };
  const send = (
    index: number,
    socket: WebSocket,
    phase: BenchmarkPhase,
    plannedMs: number,
  ) => {
    connections.check();
    const buffered = sources.reduce(
      (sum, source) => sum + source.bufferedAmount,
      0,
    );
    maxBufferedBytes = Math.max(maxBufferedBytes, buffered);
    maxPending = Math.max(maxPending, oracle.pendingCount);
    if (buffered >= 16 * 1024 * 1024 || oracle.pendingCount >= 10000)
      throw new BenchmarkLimit("Benchmark sender bound reached");
    const publication = workload.publication(index);
    const wire = JSON.stringify(publication);
    if (buffered + Buffer.byteLength(wire) > 16 * 1024 * 1024)
      throw new BenchmarkLimit("Benchmark sender byte bound reached");
    oracle.register(publication, {
      phase,
      plannedMs,
      submittedMs: () => {
        const atMs = performance.now();
        wireBytes.sentEnvelopes += Buffer.byteLength(wire);
        wireBytes.envelopes++;
        socket.send(wire, (cause) => {
          if (cause) connections.fail(cause);
        });
        return atMs;
      },
    });
    maxPending = Math.max(maxPending, oracle.pendingCount);
    latest.set(publication.sourceEntityId, publication);
    maxBufferedBytes = Math.max(
      maxBufferedBytes,
      sources.reduce((sum, source) => sum + source.bufferedAmount, 0),
    );
  };
  try {
    if (session.processId !== undefined) options.onReady?.(session.processId);
    for (let i = 0; i < options.workload.sourceSockets; i++)
      sources.push(
        await connections.open(
          session.baseUrl.replace("http:", "ws:") + "/events",
          (value, time, bytes) => {
            wireBytes.receivedReceipts += bytes;
            wireBytes.receipts++;
            checkArrival(time);
            oracle.recordReceipt(value, time);
          },
        ),
      );
    const seedDeadline = performance.now() + 300000;
    for (let entity = 0; entity < options.workload.residentEntities; entity++) {
      for (
        let item = 0;
        item < (entity < options.workload.hotEntities ? 64 : 1);
        item++
      ) {
        if (performance.now() >= seedDeadline)
          throw new Error("Benchmark seed deadline exceeded");
        send(
          entity,
          sources[entity % sources.length],
          "seed",
          performance.now(),
        );
        await wait(
          () => oracle.pendingCount === 0,
          Math.max(1, seedDeadline - performance.now()),
        );
      }
    }
    phaseTimes.seedCompletedMs = performance.now();
    for (const viewer of workload.viewerIds) {
      const awaiting = new Set<string>();
      const admitted = new Set<string>();
      const socket = await connections.open(
        session.baseUrl.replace("http:", "ws:") + "/views/live",
        (raw, atMs, bytes) => {
          const value = raw as {
            type?: string;
            viewId?: string;
            entityId?: string;
          };
          if (value.type === "view-update") {
            wireBytes.receivedViewFrames += bytes;
            wireBytes.viewFrames++;
          }
          const key = JSON.stringify([value.viewId, value.entityId]);
          if (value.type === "subscribed") {
            if (!awaiting.has(key) || admitted.has(key))
              throw new Error("Unexpected subscription acknowledgement");
            admitted.add(key);
          } else if (value.type === "view-update" && awaiting.has(key)) {
            if (!admitted.has(key))
              throw new Error(
                "Baseline arrived before subscription acknowledgement",
              );
            const publication = latest.get(value.entityId!)!;
            oracle.verifySnapshot(value.viewId!, publication, value);
            awaiting.delete(key);
          } else {
            checkArrival(atMs);
            oracle.recordUpdate(viewer, raw, atMs);
          }
        },
      );
      for (const viewId of workload.viewIds)
        for (let i = 0; i < options.workload.hotEntities; i++) {
          const entityId = workload.entity(i);
          awaiting.add(JSON.stringify([viewId, entityId]));
          socket.send(
            JSON.stringify({ action: "subscribe", viewId, entityId }),
          );
        }
      await wait(() => awaiting.size === 0, 10000);
    }
    await options.onBoundary?.("before-warmup");
    const startMs = performance.now();
    drainEnd =
      startMs + warmup.durationMs + measurement.durationMs + options.drainMs;
    await driveWindows(
      [warmup, measurement],
      windows,
      startMs,
      {
        now: () => performance.now(),
        sleep: (ms) =>
          ms > 0
            ? delay(ms, undefined, { signal: session.signal })
            : yieldTurn(undefined, { signal: session.signal }),
      },
      () => connections.check(),
      (phase, slot, plannedMs) => {
        const entity = slot % options.workload.hotEntities;
        send(entity, sources[entity % sources.length], phase, plannedMs);
      },
      async (phase) => {
        if (phase === "measurement")
          await options.onBoundary?.("measurement-start");
      },
    );
    await options.onBoundary?.("measurement-end");
    await wait(() => oracle.pendingCount === 0, drainEnd - performance.now());
    for (const viewId of workload.viewIds)
      for (let i = 0; i < options.workload.hotEntities; i++) {
        const publication = latest.get(workload.entity(i))!;
        const query = new URLSearchParams({
          viewId,
          entityId: publication.sourceEntityId,
        });
        const response = await fetch(`${session.baseUrl}/views?${query}`, {
          signal: AbortSignal.any([session.signal, AbortSignal.timeout(10000)]),
        });
        if (!response.ok)
          throw new Error(`Terminal snapshot HTTP ${response.status}`);
        oracle.verifySnapshot(viewId, publication, await response.json());
        finalSnapshots++;
      }
    connections.check();
  } catch (cause) {
    error = String(cause);
    errorKind =
      cause instanceof BenchmarkLimit
        ? "harness-limited"
        : /deadline exceeded|connection closed unexpectedly|TimeoutError|AbortError/.test(
              String(cause),
            )
          ? "service-budget"
          : "correctness";
  } finally {
    connections.close();
    try {
      await session.close({ requireOrderly: true });
    } catch (cause) {
      cleanupError = String(cause);
      error ??= cleanupError;
      errorKind ??= "correctness";
    }
  }
  return {
    report: {
      format: "benchmark-driver/v1",
      status: error ? "failed" : "completed",
      error,
      cleanupError,
      errorKind,
      options: {
        workload: options.workload,
        rate: options.rate,
        warmupMs: options.warmupMs,
        measurementMs: options.measurementMs,
        drainMs: options.drainMs,
      },
      configuration: workload.configuration,
      windows,
      maxBufferedBytes,
      maxPending,
      wireBytes,
      phaseTimes,
      finalSnapshots,
      accounting: oracle.summary(),
      capacityAssessment: "not-run",
    },
    observations: oracle.rawChunks(),
  };
}
