import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { playScenario } from "../../src/scenario/playback.js";
import { loadScenario } from "../../src/scenario/scenario.js";

const scenarioPath = fileURLToPath(
  new URL("../../scenarios/disconnect-catch-up.json", import.meta.url),
);

test("plays location updates alongside the viewer connection state", async () => {
  const scenario = await loadScenario(scenarioPath);
  const events = playScenario(scenario);
  const disconnectedAt = events.find(
    (entry) => entry.kind === "client-state" && entry.state === "disconnected",
  )?.simulationTime;
  const reconnectedAt = events.find(
    (entry) =>
      entry.kind === "client-state" &&
      entry.state === "connected" &&
      entry.simulationTime > Number(disconnectedAt),
  )?.simulationTime;
  const updatesDuringDisconnect = events.filter(
    (entry) =>
      entry.kind === "source-event" &&
      entry.type === "vehicle.location.updated" &&
      entry.simulationTime > Number(disconnectedAt) &&
      entry.simulationTime < Number(reconnectedAt),
  );
  const clientTransitions = events.filter(
    (entry) => entry.kind === "client-state",
  );
  const initialState = events.find(
    (entry) => entry.kind === "client-initial-state",
  );

  assert.ok(disconnectedAt !== undefined);
  assert.ok(reconnectedAt !== undefined);
  assert.equal(initialState?.state, "disconnected");
  assert.equal(updatesDuringDisconnect.length, 2);
  assert.deepEqual(
    clientTransitions.map((entry) => entry.state),
    [
      "connecting",
      "connected",
      "disconnecting",
      "disconnected",
      "connecting",
      "connected",
    ],
  );
  assert.ok(reconnectedAt > Number(disconnectedAt));
});
