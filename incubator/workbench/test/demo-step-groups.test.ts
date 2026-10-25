import assert from "node:assert/strict";
import test from "node:test";
import { createDemoController } from "../src/demo-controller.js";
import { playScenario, type TraceEntry } from "../src/playback.js";
import { planDemoSteps } from "../src/demo-steps.js";
import type { Scenario } from "../src/scenario.js";

const scenario: Scenario = {
  name: "Step boundaries",
  sources: [{ id: "feed", name: "Feed" }],
  clients: [{ id: "viewer", name: "Viewer", initialState: "connected" }],
  views: [],
  timeline: [
    {
      kind: "client-subscription",
      simulationTime: 10,
      clientId: "viewer",
      action: "subscribe",
      viewId: "position",
      entityId: "one",
    },
    {
      kind: "source-event",
      simulationTime: 50,
      sourceId: "feed",
      type: "changed",
      entityId: "one",
      payload: {},
    },
    {
      kind: "view-check",
      simulationTime: 70,
      viewId: "position",
      entityId: "one",
      expected: {},
    },
    {
      kind: "client-state",
      simulationTime: 100,
      clientId: "viewer",
      state: "disconnected",
    },
    {
      kind: "view-check",
      simulationTime: 120,
      viewId: "position",
      entityId: "one",
      expected: {},
    },
    {
      kind: "source-event",
      simulationTime: 120,
      sourceId: "feed",
      type: "changed",
      entityId: "one",
      payload: {},
    },
    {
      kind: "client-view-check",
      simulationTime: 140,
      clientId: "viewer",
      viewId: "position",
      entityId: "one",
      expected: {},
    },
  ],
};

test("setup precedes source steps and connection actions start their own checkpoint", async () => {
  const entries: TraceEntry[] = [];
  const demo = createDemoController(scenario, async (signal) => ({
    signal,
    publish() {},
    async close() {},
    async execute(entry) {
      entries.push(entry);
    },
  }));
  const takeKinds = () => entries.splice(0).map((entry) => entry.kind);
  try {
    await demo.reset();
    assert.equal(demo.state.total, 3);
    assert.deepEqual(takeKinds(), [
      "client-initial-state",
      "client-subscription",
    ]);
    await demo.step();
    assert.deepEqual(takeKinds(), ["source-event", "view-check"]);
    assert.equal(demo.state.completed, 1);
    await demo.step();
    assert.deepEqual(takeKinds(), ["client-state", "view-check"]);
    await demo.step();
    assert.deepEqual(takeKinds(), ["source-event", "client-view-check"]);
    assert.equal(demo.state.phase, "complete");
    await demo.reset();
    takeKinds();
    await demo.step();
    assert.deepEqual(takeKinds(), ["source-event", "view-check"]);
    assert.equal(demo.state.completed, 1);
  } finally {
    await demo.close();
  }
});

test("a demo without a source event is rejected before opening a run", () => {
  let opened = false;
  assert.throws(
    () =>
      createDemoController({ ...scenario, timeline: [] }, async () => {
        opened = true;
        throw new Error("unreachable");
      }),
    { message: "The demo needs at least one source event." },
  );
  assert.equal(opened, false);
});

test("step delays use the preceding checkpoint's final timestamp", () => {
  const trace = playScenario(scenario);
  const original = structuredClone(trace);
  const plan = planDemoSteps(trace);
  assert.deepEqual(
    plan.steps.map((step) => step.delayBefore),
    [40, 30, 0],
  );
  assert.deepEqual(
    plan.steps.map((step) => step.entries.map((entry) => entry.simulationTime)),
    [
      [50, 70],
      [100, 120],
      [120, 140],
    ],
  );
  assert.deepEqual(
    trace,
    original,
    "planning must not reorder or change the input trace",
  );
});

test("the first step waits from zero when no setup entries precede it", () => {
  const trace = playScenario({
    ...scenario,
    clients: [],
    timeline: [scenario.timeline[1]],
  });
  const plan = planDemoSteps(trace);
  assert.deepEqual(plan.setup, []);
  assert.equal(plan.steps[0].delayBefore, 50);
});
