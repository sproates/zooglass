import {
  setTimeout as delay,
  setImmediate as yieldTurn,
} from "node:timers/promises";
import { BenchmarkOracle } from "./oracle.js";
import { Schedule } from "./schedule.js";
import { Workload, type WorkloadOptions } from "./workload.js";

/** Client-only protocol parsing/accounting check. Never a service capacity measurement. */
export async function clientDiagnostic(options: WorkloadOptions) {
  const workload = new Workload(options);
  const oracle = new BenchmarkOracle({
    storage: options.storage,
    viewIds: workload.viewIds,
    viewerIds: workload.viewerIds,
  });
  const schedule = new Schedule(1000, 1000);
  const start = performance.now();
  let missed = 0,
    submitted = 0,
    frameBytes = 0,
    envelopeBytes = 0;
  while (schedule.remaining) {
    const step = schedule.wake(performance.now() - start);
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
      oracle.register(parsed, {
        phase: "measurement",
        plannedMs: start + step.plannedMs!,
        submittedMs: performance.now(),
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
          const at = performance.now();
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
      const at = performance.now();
      oracle.recordReceipt(JSON.parse(receipt), at);
      submitted++;
    }
    const wait = start + schedule.nextMs - performance.now();
    if (wait > 0) await delay(wait);
    else await yieldTurn();
  }
  return {
    kind: "client-only",
    offeredRate: 1000,
    durationMs: 1000,
    submitted,
    missed,
    envelopeBytes,
    frameBytes,
    qualified: missed === 0 && submitted === 1000 && oracle.pendingCount === 0,
    limitation:
      "Local serialization, parsing and oracle only; excludes sockets and ZooGlass",
    accounting: oracle.summary(),
  };
}
