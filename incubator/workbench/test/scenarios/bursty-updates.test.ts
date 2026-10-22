import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { playScenario } from "../../src/playback.js";
import { loadScenario } from "../../src/scenario.js";

const scenarioPath = fileURLToPath(
  new URL("../../scenarios/bursty-updates.json", import.meta.url),
);

test("keeps a burst of updates in time order", async () => {
  const scenario = await loadScenario(scenarioPath);
  const oddsEvents = playScenario(scenario).filter(
    (entry) => entry.kind === "source-event" && entry.type === "odds.updated",
  );

  assert.equal(oddsEvents.length, 4);
  assert.deepEqual(
    oddsEvents.map((event) => event.simulationTime),
    [1000, 1002, 1004, 1010],
  );
  assert.ok(
    oddsEvents.at(-1)!.simulationTime - oddsEvents[0]!.simulationTime <= 10,
  );
});
