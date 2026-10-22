import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { playScenario } from "../../src/playback.js";
import { loadScenario } from "../../src/scenario.js";

const scenarioPath = fileURLToPath(
  new URL("../../scenarios/live-match.json", import.meta.url),
);

test("loads the live match score and odds timeline", async () => {
  const scenario = await loadScenario(scenarioPath);

  assert.equal(
    scenario.name,
    "A live match with independent score and odds feeds",
  );
  assert.deepEqual(
    playScenario(scenario).map((event) => event.simulationTime),
    [0, 250, 1200, 1350],
  );
});
