import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { playScenario } from "../../src/playback.js";
import { loadScenario } from "../../src/scenario.js";

const scenarioPath = fileURLToPath(
  new URL("../../scenarios/client-reconnect-snapshot.json", import.meta.url),
);

test("a reconnecting client resubscribes and receives the latest snapshot", async () => {
  const scenario = await loadScenario(scenarioPath);
  const trace = playScenario(scenario);
  const disconnectedAt = trace.find(
    (entry) => entry.kind === "client-state" && entry.state === "disconnected",
  )?.simulationTime;
  const reconnectedAt = trace.find(
    (entry) =>
      entry.kind === "client-state" &&
      entry.state === "connected" &&
      entry.simulationTime > Number(disconnectedAt),
  )?.simulationTime;
  const missedEvents = trace.filter(
    (entry) =>
      entry.kind === "source-event" &&
      entry.simulationTime > Number(disconnectedAt) &&
      entry.simulationTime < Number(reconnectedAt),
  );
  const subscriptions = trace.filter(
    (entry) => entry.kind === "client-subscription",
  );
  const clientViewChecks = trace.filter(
    (entry) => entry.kind === "client-view-check",
  );

  assert.ok(disconnectedAt !== undefined);
  assert.ok(reconnectedAt !== undefined);
  assert.equal(missedEvents.length, 2);
  assert.equal(subscriptions.length, 2);
  assert.ok(subscriptions[1]!.simulationTime > Number(reconnectedAt));
  assert.equal(clientViewChecks.length, 2);
  assert.deepEqual(clientViewChecks[1]?.expected, {
    score: { home: 2, away: 1 },
  });
});
