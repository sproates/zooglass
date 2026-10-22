import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { playScenario } from "../../src/playback.js";
import { loadScenario } from "../../src/scenario.js";

const scenarioPath = fileURLToPath(
  new URL("../../scenarios/disconnect-catch-up.json", import.meta.url),
);

test("shows feed updates during a disconnect and a catch-up on reconnect", async () => {
  const scenario = await loadScenario(scenarioPath);
  const events = playScenario(scenario);
  const disconnectedAt = events.find(
    (event) => event.type === "client.disconnected",
  )?.simulationTime;
  const reconnectedAt = events.find(
    (event) => event.type === "client.reconnected",
  )?.simulationTime;
  const updatesDuringDisconnect = events.filter(
    (event) =>
      event.type === "vehicle.location.updated" &&
      event.simulationTime > Number(disconnectedAt) &&
      event.simulationTime < Number(reconnectedAt),
  );
  const replay = events.find(
    (event) => event.type === "vehicle.location.replayed",
  );

  assert.ok(disconnectedAt !== undefined);
  assert.ok(reconnectedAt !== undefined);
  assert.equal(updatesDuringDisconnect.length, 2);
  assert.ok(replay);
  assert.equal(replay.simulationTime, reconnectedAt);
  assert.equal(replay.payload.updatesSinceDisconnect, 2);
});
