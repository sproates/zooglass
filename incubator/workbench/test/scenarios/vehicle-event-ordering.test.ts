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
});
