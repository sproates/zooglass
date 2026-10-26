import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadScenario } from "../../src/scenario/scenario.js";
import { playScenario } from "../../src/scenario/playback.js";

test("recovery checks duplicate suppression only after a same-source processing barrier", async () => {
  const scenario = await loadScenario(
    fileURLToPath(
      new URL("../../scenarios/vehicle-browser-recovery.json", import.meta.url),
    ),
  );
  const trace = [...playScenario(scenario)];
  const copies = trace.filter(
    (entry) =>
      entry.kind === "source-event" &&
      entry.entityId === "car-17" &&
      entry.payload.sequence === 41,
  );

  assert.equal(copies.length, 2, "the fixture must actually send duplicate 41");
  const [original, duplicate] = copies;
  assert.ok(original.kind === "source-event");
  assert.ok(duplicate.kind === "source-event");
  assert.deepEqual(duplicate.payload, original.payload);

  const duplicateIndex = trace.indexOf(duplicate);
  const barrierIndex = trace.findIndex(
    (entry) =>
      entry.kind === "source-event" && entry.entityId === "processing-barrier",
  );
  assert.ok(barrierIndex > duplicateIndex);
  const barrier = trace[barrierIndex];
  assert.ok(barrier.kind === "source-event");
  assert.equal(
    barrier.sourceName,
    duplicate.sourceName,
    "ordering requires the same source socket",
  );

  const receiptIndex = trace.findIndex(
    (entry, index) =>
      index > barrierIndex &&
      entry.kind === "view-check" &&
      entry.entityId === "processing-barrier",
  );
  const historyIndex = trace.findIndex(
    (entry, index) =>
      index > duplicateIndex &&
      entry.kind === "view-check" &&
      entry.entityId === "car-17" &&
      entry.viewId === "trip-history",
  );
  assert.ok(
    receiptIndex > barrierIndex,
    "wait for the barrier to reach the service view",
  );
  assert.ok(
    historyIndex > receiptIndex,
    "check unchanged history only after processing is established",
  );
});
