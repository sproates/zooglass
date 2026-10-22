import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { playScenario } from "../../src/playback.js";
import { loadScenario } from "../../src/scenario.js";

const scenarioPath = fileURLToPath(
  new URL("../../scenarios/live-view-updates.json", import.meta.url),
);

test("subscribes a client before checking its live view updates", async () => {
  const scenario = await loadScenario(scenarioPath);
  const trace = playScenario(scenario);

  assert.deepEqual(
    trace
      .filter(
        (entry) =>
          entry.kind === "client-subscription" ||
          entry.kind === "client-view-check",
      )
      .map((entry) => entry.kind),
    ["client-subscription", "client-view-check", "client-view-check"],
  );
  assert.equal(
    trace.filter(
      (entry) => entry.kind === "client-view-check" && entry.viewId === "match",
    ).length,
    2,
  );
  assert.equal(
    trace.filter((entry) => entry.kind === "source-event").length,
    2,
  );
});
