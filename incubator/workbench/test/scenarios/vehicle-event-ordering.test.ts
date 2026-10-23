import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { loadScenario } from "../../src/scenario.js";

const scenarioPath = fileURLToPath(
  new URL("../../scenarios/vehicle-event-ordering.json", import.meta.url),
);

test("vehicle ordering scenario configures latest and history views", async () => {
  const scenario = await loadScenario(scenarioPath);

  assert.deepEqual(scenario.views[0]?.ordering, {
    position: { mode: "latestBySequence", sequenceField: "sequence" },
  });
  assert.deepEqual(scenario.views[1]?.ordering, {
    positions: { mode: "historyBySequence", sequenceField: "sequence" },
  });
  assert.ok(
    scenario.timeline.some(
      (entry) =>
        entry.kind === "view-definition" &&
        entry.ordering?.position?.mode === "latestBySequence",
    ),
  );

  const sequence43At = scenario.timeline.find(
    (entry) => entry.kind === "source-event" && entry.payload.sequence === 43,
  )?.simulationTime;
  const reconnectAt = scenario.timeline.find(
    (entry) => entry.kind === "client-state" && entry.state === "connecting",
  )?.simulationTime;
  const sequence43Checks = scenario.timeline.filter(
    (entry) =>
      entry.kind === "view-check" &&
      entry.entityId === "car-17" &&
      entry.expected !== null &&
      JSON.stringify(entry.expected).includes('"sequence":43'),
  );

  assert.equal(sequence43At, 80);
  assert.equal(reconnectAt, 90);
  assert.equal(sequence43Checks.length, 2);
  assert.ok(
    sequence43Checks.every((entry) => entry.simulationTime > sequence43At!),
  );
  assert.ok(
    sequence43Checks.every((entry) => entry.simulationTime < reconnectAt!),
  );
});
