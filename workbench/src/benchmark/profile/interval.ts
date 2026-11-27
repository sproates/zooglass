import type { Observation } from "../model.js";

/** Event-time counts include callbacks for work already pending at the interval start. */
export async function intervalActivity(
  records: AsyncIterable<Observation>,
  startMs: number,
  endMs: number,
) {
  if (
    !Number.isFinite(startMs) ||
    !Number.isFinite(endMs) ||
    endMs <= startMs
  ) {
    throw new Error("Invalid observation interval");
  }
  let submitted = 0,
    receipts = 0,
    updates = 0;
  let awaitingAtStart = 0;
  let awaitingUpdatesAtStart = 0;
  let expectedUpdates = 0;
  for await (const row of records) {
    if (row.atMs >= endMs) continue;
    const before = row.atMs < startMs;
    if (row.kind === "submit") {
      const expectsUpdate = row.phase !== "seed";
      if (before) {
        awaitingAtStart++;
        if (expectsUpdate) awaitingUpdatesAtStart++;
      } else {
        submitted++;
        if (expectsUpdate) expectedUpdates++;
      }
    } else if (row.kind === "receipt") {
      if (before) awaitingAtStart--;
      else receipts++;
    } else if (row.kind === "update") {
      if (before) awaitingUpdatesAtStart--;
      else updates++;
    }
  }
  return {
    startMs,
    endMs,
    submitted,
    receipts,
    updates,
    receiptBacklogStart: awaitingAtStart,
    receiptBacklogEnd: awaitingAtStart + submitted - receipts,
    fanoutBacklogStart: awaitingUpdatesAtStart,
    fanoutBacklogEnd: awaitingUpdatesAtStart + expectedUpdates - updates,
  };
}
