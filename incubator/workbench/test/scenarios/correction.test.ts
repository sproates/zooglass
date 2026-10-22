import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { playScenario } from "../../src/playback.js";
import { loadScenario } from "../../src/scenario.js";

const scenarioPath = fileURLToPath(
  new URL("../../scenarios/correction.json", import.meta.url),
);

test("places the corrected score after the original report", async () => {
  const scenario = await loadScenario(scenarioPath);
  const events = playScenario(scenario).filter(
    (entry) => entry.kind === "source-event",
  );
  const original = events.find((event) => event.type === "score.updated");
  const correction = events.find((event) => event.type === "score.corrected");

  assert.ok(original);
  assert.ok(correction);
  assert.ok(correction.simulationTime > original.simulationTime);
  assert.equal(correction.payload.correctsRevision, 2);
  assert.equal(correction.payload.revision, 3);
});
