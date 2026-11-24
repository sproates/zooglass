import { benchmarkClock } from "./clock.js";
import { BenchmarkOracle } from "./oracle.js";
import { Schedule } from "./schedule.js";
import { Workload, type WorkloadOptions } from "./workload.js";

export interface DiagnosticTiming {
  rate: number;
  durationMs: number;
  signal?: AbortSignal;
  capture?: boolean;
  clock?: { now(): number; sleep(ms: number): Promise<void> };
}

/** Client-only protocol parsing/accounting check. Never a service capacity measurement. */
export async function clientDiagnostic(
  options: WorkloadOptions,
  timing?: DiagnosticTiming,
) {
  const rate = timing?.rate ?? 1000;
  const durationMs = timing?.durationMs ?? 1000;
  const clock = timing?.clock ?? benchmarkClock(timing?.signal);
  const wakes: {
    atMs: number;
    slot?: number;
    plannedMs?: number;
    missed: number;
  }[] = [];
  const submissions: { plannedMs: number; atMs: number }[] = [];
  const workload = new Workload(options);
  const oracle = new BenchmarkOracle({
    storage: options.storage,
    viewIds: workload.viewIds,
    viewerIds: workload.viewerIds,
  });
  const schedule = new Schedule(rate, durationMs);
  const start = clock.now();
  let missed = 0,
    submitted = 0,
    frameBytes = 0,
    envelopeBytes = 0;
  while (schedule.remaining) {
    timing?.signal?.throwIfAborted();
    const atMs = clock.now();
    const step = schedule.wake(atMs - start);
    if (timing?.capture) {
      if (wakes.length >= 1000000)
        throw new Error("Diagnostic wake-record bound reached");
      wakes.push({ atMs, ...step });
    }
    missed += step.missed;
    if (step.slot !== undefined) {
      const p = workload.publication(step.slot % options.hotEntities);
      const source = {
        sourceId: p.sourceId,
        epoch: p.epoch,
        sourceEntityId: p.sourceEntityId,
      };
      const wire = JSON.stringify(p);
      envelopeBytes += Buffer.byteLength(wire);
      const parsed = JSON.parse(wire);
      const submittedMs = clock.now();
      if (timing?.capture)
        submissions.push({
          plannedMs: start + step.plannedMs!,
          atMs: submittedMs,
        });
      oracle.register(parsed, {
        phase: "measurement",
        plannedMs: start + step.plannedMs!,
        submittedMs,
      });
      for (const viewerId of workload.viewerIds)
        for (const viewId of workload.viewIds) {
          const frame = JSON.stringify({
            type: "view-update",
            viewId,
            entityId: p.sourceEntityId,
            version: step.slot! + 1,
            provenance: { value: source },
            publicationSequences: { value: [p.publicationSequence] },
            data: { value: p.payload },
          });
          frameBytes += Buffer.byteLength(frame);
          const at = clock.now();
          oracle.recordUpdate(viewerId, JSON.parse(frame), at);
        }
      const receipt = JSON.stringify({
        status: options.storage === "sqlite" ? "committed" : "applied",
        reason: options.storage,
        stream: source,
        publicationSequence: p.publicationSequence,
        version: step.slot! + 1,
        changedViews: workload.viewIds,
        targets: workload.viewIds.map((viewId) => ({
          viewId,
          entityId: p.sourceEntityId,
          status: "accepted",
          reason: null,
          changedFields: ["value"],
          fields: [
            { field: "value", status: "accepted", reason: null, changed: true },
          ],
        })),
      });
      const at = clock.now();
      oracle.recordReceipt(JSON.parse(receipt), at);
      submitted++;
    }
    const wait = start + schedule.nextMs - clock.now();
    await clock.sleep(wait);
  }
  return {
    kind: "client-only",
    offeredRate: rate,
    durationMs,
    submitted,
    missed,
    envelopeBytes,
    frameBytes,
    qualified:
      missed === 0 && submitted === schedule.total && oracle.pendingCount === 0,
    limitation:
      "Local serialization, parsing and oracle only; excludes sockets and ZooGlass",
    accounting: oracle.summary(),
    ...(timing?.capture
      ? {
          timing: {
            startMs: start,
            endMs: clock.now(),
            wakes,
            submissions,
            lateSubmissions: submissions.filter(
              (s) =>
                s.atMs - s.plannedMs > 10 ||
                s.atMs - s.plannedMs >= 1000 / rate ||
                s.atMs >= start + durationMs,
            ).length,
          },
        }
      : {}),
  };
}
