import assert from "node:assert/strict";
import test from "node:test";
import { planDemoSteps } from "../src/control/demo-steps.js";
import { playScenario } from "../src/scenario/playback.js";
import { parseScenario } from "../src/scenario/scenario.js";

function trace(timeline: unknown[]) {
  return playScenario(
    parseScenario({
      name: "Step planning",
      sources: [{ id: "feed", name: "Feed" }],
      clients: [{ id: "viewer", name: "Viewer", initialState: "connected" }],
      views: [
        {
          id: "current",
          fields: { value: [{ sourceId: "feed", type: "value" }] },
        },
      ],
      timeline,
    }),
  );
}

function event(simulationTime: number) {
  return {
    epoch: "run",
    publicationSequence: 1,
    kind: "source-event",
    simulationTime,
    sourceId: "feed",
    type: "value",
    entityId: "one",
    payload: { value: 1 },
  };
}

function check(simulationTime: number) {
  return {
    kind: "client-view-check",
    simulationTime,
    clientId: "viewer",
    viewId: "current",
    entityId: "one",
    expected: { value: 1 },
  };
}

test("planning keeps setup separate and measures delay from the last check", () => {
  const input = trace([
    {
      kind: "client-subscription",
      simulationTime: 5,
      clientId: "viewer",
      action: "subscribe",
      viewId: "current",
      entityId: "one",
    },
    event(20),
    check(30),
    event(50),
    check(55),
  ]);
  const before = structuredClone(input);
  const plan = planDemoSteps(input);

  assert.deepEqual(
    plan.setup.map((entry) => entry.kind),
    ["client-initial-state", "client-subscription"],
  );
  assert.deepEqual(
    plan.steps.map((step) => ({
      delay: step.delayBefore,
      times: step.entries.map((entry) => entry.simulationTime),
    })),
    [
      { delay: 15, times: [20, 30] },
      { delay: 20, times: [50, 55] },
    ],
  );
  assert.deepEqual(input, before);
  plan.steps[0].entries.pop();
  assert.deepEqual(input, before, "step arrays must not alias the input array");
});

test("state and route faults start checkpoints while tied checks remain with their action", () => {
  const plan = planDemoSteps(
    trace([
      event(0),
      check(0),
      {
        kind: "client-state",
        simulationTime: 10,
        clientId: "viewer",
        state: "disconnected",
      },
      {
        kind: "data-connection-fault",
        simulationTime: 20,
        clientId: "viewer",
        action: "break",
        timeoutMs: 1,
      },
      event(20),
      check(20),
      {
        kind: "data-connection-fault",
        simulationTime: 30,
        clientId: "viewer",
        action: "restore",
      },
    ]),
  );
  assert.deepEqual(
    plan.steps.map((step) => step.entries.map((entry) => entry.kind)),
    [
      ["source-event", "client-view-check"],
      ["client-state"],
      ["data-connection-fault"],
      ["source-event", "client-view-check"],
      ["data-connection-fault"],
    ],
  );
  assert.deepEqual(
    plan.steps.map((step) => step.delayBefore),
    [0, 10, 10, 0, 10],
  );
});

test("a trace without a source action cannot become a stepped run", () => {
  assert.throws(() => planDemoSteps(trace([])), {
    message: "The demo needs at least one source event.",
  });
});
