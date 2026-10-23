import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { loadScenario } from "../../src/scenario.js";

const scenariosDirectory = new URL("../../scenarios/", import.meta.url);

test("sports betting scenario combines score and bookmaker odds for a client", async () => {
  const scenario = await loadScenario(
    fileURLToPath(
      new URL("sports-betting-live-market.json", scenariosDirectory),
    ),
  );

  assert.deepEqual(
    scenario.sources.map((source) => source.id),
    ["match-feed", "bookmaker"],
  );
  assert.equal(scenario.views[0]?.fields.score?.length, 1);
  assert.equal(scenario.views[0]?.fields.odds?.length, 1);
  assert.equal(
    scenario.timeline.filter((entry) => entry.kind === "client-view-check")
      .length,
    4,
  );
});

test("order fulfilment scenario combines order, payment, and inventory updates", async () => {
  const scenario = await loadScenario(
    fileURLToPath(
      new URL("order-fulfilment-live-order.json", scenariosDirectory),
    ),
  );

  assert.deepEqual(
    scenario.sources.map((source) => source.id),
    ["orders", "payments", "inventory"],
  );
  assert.deepEqual(Object.keys(scenario.views[0]?.fields ?? {}).sort(), [
    "inventory",
    "order",
    "payment",
  ]);
  assert.equal(
    scenario.timeline.filter((entry) => entry.kind === "client-view-check")
      .length,
    4,
  );
});

test("vehicle tracking scenario follows a ride across a client reconnect", async () => {
  const scenario = await loadScenario(
    fileURLToPath(
      new URL("vehicle-tracking-live-ride.json", scenariosDirectory),
    ),
  );
  const clientStates = scenario.timeline
    .filter((entry) => entry.kind === "client-state")
    .map((entry) => entry.state);

  assert.equal(scenario.sources[0]?.id, "vehicle-feed");
  assert.deepEqual(clientStates, [
    "connecting",
    "connected",
    "disconnecting",
    "disconnected",
    "connecting",
    "connected",
  ]);
  assert.equal(
    scenario.timeline.filter((entry) => entry.kind === "client-subscription")
      .length,
    2,
  );
  assert.equal(
    scenario.timeline.filter((entry) => entry.kind === "client-view-check")
      .length,
    4,
  );
});
