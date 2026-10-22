import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { playScenario } from "../../src/playback.js";
import { loadScenario } from "../../src/scenario.js";

const scenarioPath = fileURLToPath(
  new URL("../../scenarios/runtime-view-definition.json", import.meta.url),
);

test("defines matching views at different points in the event timeline", async () => {
  const scenario = await loadScenario(scenarioPath);
  const trace = playScenario(scenario);

  assert.deepEqual(
    trace
      .filter((entry) => entry.kind === "view-definition")
      .map(({ id, simulationTime }) => ({ id, simulationTime })),
    [
      { id: "primary-view", simulationTime: 0 },
      { id: "secondary-view", simulationTime: 200 },
    ],
  );
  assert.equal(
    trace.filter(
      (entry) => entry.kind === "view-check" && entry.expected === null,
    ).length,
    2,
  );
  assert.deepEqual(
    trace
      .filter((entry) => entry.kind === "view-check" && entry.expected !== null)
      .map((entry) => entry.viewId),
    ["event-observer", "primary-view", "primary-view", "secondary-view"],
  );
});
