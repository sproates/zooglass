import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadScenario } from "../../src/scenario/scenario.js";

const fixturePath = fileURLToPath(
  new URL("../../scenarios/vehicle-fleet-contracts.json", import.meta.url),
);

interface FleetManifest {
  vehicles: { id: string; name: string }[];
}

test("fleet manifest is descriptive and every vehicle receives both views", async () => {
  const manifest = JSON.parse(
    await readFile(
      new URL("../../../vehicle-tracker/fleet-manifest.json", import.meta.url),
      "utf8",
    ),
  ) as FleetManifest;
  const scenario = await loadScenario(fixturePath);
  const vehicleIds = manifest.vehicles.map((vehicle) => vehicle.id);

  assert.equal(vehicleIds.length, 3);
  assert.equal(new Set(vehicleIds).size, vehicleIds.length);

  for (const vehicle of manifest.vehicles) {
    assert.deepEqual(Object.keys(vehicle).sort(), ["id", "name"]);
    assert.ok(vehicle.id.length > 0 && vehicle.name.length > 0);
  }

  const events = scenario.timeline.filter(
    (entry) => entry.kind === "source-event",
  );
  assert.deepEqual(
    [...new Set(events.map((entry) => entry.entityId))].sort(),
    vehicleIds.toSorted(),
  );

  const subscriptions = scenario.timeline.filter(
    (entry) => entry.kind === "client-subscription",
  );
  assert.equal(subscriptions.length, vehicleIds.length * 2);

  for (const entityId of vehicleIds) {
    const sources = events
      .filter((entry) => entry.entityId === entityId)
      .map((entry) => entry.sourceId);
    assert.deepEqual([...new Set(sources)].sort(), [
      "operations-feed",
      "vehicle-feed",
    ]);

    for (const viewId of ["fleet-state", "received-journey"]) {
      assert.equal(
        subscriptions.filter(
          (entry) =>
            entry.entityId === entityId &&
            entry.viewId === viewId &&
            entry.action === "subscribe",
        ).length,
        1,
      );
      assert.ok(
        scenario.timeline.some(
          (entry) =>
            entry.kind === "client-view-check" &&
            entry.entityId === entityId &&
            entry.viewId === viewId,
        ),
      );
    }
  }
});

test("fleet duplicate checks wait for both source streams to cross an observed barrier", async () => {
  const { timeline } = await loadScenario(fixturePath);
  const barrierIndex = timeline.findIndex(
    (entry) => entry.kind === "view-check" && entry.entityId === "car-39",
  );
  assert.ok(barrierIndex >= 0);
  const barrier = timeline[barrierIndex];
  assert.ok(barrier.kind === "view-check");
  assert.deepEqual(barrier.expected, {
    position: { sequence: 41, latitude: 36.1389, longitude: -5.3526 },
    operation: { sequence: 101, status: "available" },
  });

  for (const [sourceId, entityId, sequence] of [
    ["vehicle-feed", "car-17", 42],
    ["operations-feed", "car-28", 102],
  ] as const) {
    const copies = timeline.filter(
      (entry) =>
        entry.kind === "source-event" &&
        entry.sourceId === sourceId &&
        entry.entityId === entityId &&
        entry.payload.sequence === sequence,
    );
    assert.ok(
      copies.length >= 2,
      "exercise a repeated sequence with a changed payload",
    );
    const first = copies[0];
    const last = copies.at(-1)!;
    assert.ok(first.kind === "source-event" && last.kind === "source-event");
    assert.notDeepEqual(first.payload, last.payload);

    const barrierEventIndex = timeline.findIndex(
      (entry, index) =>
        index > timeline.indexOf(last) &&
        entry.kind === "source-event" &&
        entry.sourceId === sourceId &&
        entry.entityId === "car-39" &&
        entry.payload.sequence === (sourceId === "vehicle-feed" ? 41 : 101),
    );
    assert.ok(barrierEventIndex > timeline.indexOf(last));
    assert.ok(barrierIndex > barrierEventIndex);
  }

  const finalChecks = timeline.slice(barrierIndex + 1);
  assert.equal(finalChecks.length, 8);
  assert.ok(
    finalChecks.every(
      (entry) =>
        entry.kind === "view-check" || entry.kind === "client-view-check",
    ),
  );
});
