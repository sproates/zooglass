import assert from "node:assert/strict";
import test from "node:test";
import { namespaceScenario } from "../src/scenario/namespace-scenario.js";
import { parseScenario } from "../src/scenario/scenario.js";

const fields = { value: [{ sourceId: "feed", type: "changed" }] };

test("namespacing rewrites static and runtime references without changing client or domain identities", () => {
  const scenario = parseScenario({
    name: "Reusable scenario",
    sources: [{ id: "feed", name: "Feed" }],
    clients: [{ id: "viewer", name: "Viewer", initialState: "connected" }],
    views: [{ id: "initial", fields }],
    timeline: [
      { kind: "view-definition", simulationTime: 0, id: "later", fields },
      {
        kind: "client-subscription",
        simulationTime: 1,
        clientId: "viewer",
        action: "subscribe",
        viewId: "later",
        entityId: "one",
      },
      {
        kind: "source-event",
        simulationTime: 2,
        sourceId: "feed",
        type: "changed",
        entityId: "one",
        payload: { value: 7 },
      },
      {
        kind: "view-check",
        simulationTime: 3,
        viewId: "initial",
        entityId: "one",
        expected: { value: 7 },
      },
      {
        kind: "client-view-check",
        simulationTime: 4,
        clientId: "viewer",
        viewId: "later",
        entityId: "one",
        expected: { value: 7 },
      },
      {
        kind: "client-state",
        simulationTime: 5,
        clientId: "viewer",
        state: "disconnected",
      },
      {
        kind: "data-connection-fault",
        simulationTime: 6,
        clientId: "viewer",
        action: "break",
      },
    ],
  });
  const before = structuredClone(scenario);
  const result = namespaceScenario(scenario, 2);

  assert.deepEqual(result.sources, [{ id: "scenario-3-feed", name: "Feed" }]);
  assert.deepEqual(result.views, [
    {
      id: "scenario-3-initial",
      fields: { value: [{ sourceId: "scenario-3-feed", type: "changed" }] },
    },
  ]);
  assert.deepEqual(result.timeline, [
    {
      kind: "view-definition",
      simulationTime: 0,
      id: "scenario-3-later",
      fields: { value: [{ sourceId: "scenario-3-feed", type: "changed" }] },
    },
    {
      kind: "client-subscription",
      simulationTime: 1,
      clientId: "viewer",
      action: "subscribe",
      viewId: "scenario-3-later",
      entityId: "one",
    },
    {
      kind: "source-event",
      simulationTime: 2,
      sourceId: "scenario-3-feed",
      type: "changed",
      entityId: "one",
      payload: { value: 7 },
    },
    {
      kind: "view-check",
      simulationTime: 3,
      viewId: "scenario-3-initial",
      entityId: "one",
      expected: { value: 7 },
    },
    {
      kind: "client-view-check",
      simulationTime: 4,
      clientId: "viewer",
      viewId: "scenario-3-later",
      entityId: "one",
      expected: { value: 7 },
    },
    {
      kind: "client-state",
      simulationTime: 5,
      clientId: "viewer",
      state: "disconnected",
    },
    {
      kind: "data-connection-fault",
      simulationTime: 6,
      clientId: "viewer",
      action: "break",
    },
  ]);
  assert.deepEqual(result.clients, before.clients);
  assert.deepEqual(scenario, before);
  result.views[0].fields.value[0].sourceId = "changed-copy";
  assert.deepEqual(
    scenario,
    before,
    "rewriting a view must not mutate its source matchers",
  );
});
