import assert from "node:assert/strict";
import test from "node:test";
import { parseScenario } from "../src/scenario/scenario.js";

function scenario() {
  return {
    name: "Parser contract",
    sources: [{ id: "feed", name: "Feed" }],
    clients: [{ id: "viewer", name: "Viewer", initialState: "disconnected" }],
    views: [
      {
        id: "current",
        fields: { value: [{ sourceId: "feed", type: "changed" }] },
      },
    ],
    timeline: [] as unknown[],
  };
}

test("runtime declarations allow forward references without sorting the timeline", () => {
  const input = scenario();

  input.timeline = [
    {
      kind: "client-subscription",
      simulationTime: 9,
      clientId: "viewer",
      action: "subscribe",
      viewId: "later",
      entityId: "one",
    },
    {
      kind: "view-check",
      simulationTime: 1,
      viewId: "later",
      entityId: "one",
      expected: null,
    },
    {
      kind: "view-definition",
      simulationTime: 9,
      id: "later",
      fields: input.views[0].fields,
    },
  ];

  const parsed = parseScenario(input);

  assert.deepEqual(parsed.timeline, input.timeline);
});

test("duplicate runtime declarations are rejected before individual timeline entries", () => {
  const input = scenario();

  input.timeline = [null, { kind: "view-definition", id: "current" }];

  assert.throws(() => parseScenario(input), {
    message: 'View id "current" is declared more than once.',
  });
  input.timeline = [
    { kind: "view-definition", id: "later" },
    { kind: "view-definition", id: "later" },
  ];

  assert.throws(() => parseScenario(input), {
    message: 'View id "later" is declared more than once.',
  });
});

test("view fields are validated before the view id", () => {
  const input = scenario();
  input.views = [
    { id: "", fields: { value: [{ sourceId: "missing", type: "" }] } },
  ];

  assert.throws(() => parseScenario(input), {
    message: 'View field "value" refers to unknown source "missing".',
  });
});

const invalidEntries = [
  { entry: null, message: "Expected timeline[0] to be an object." },
  {
    entry: { kind: "unknown", simulationTime: -1 },
    message:
      "Expected timeline[0].simulationTime to be a non-negative integer.",
  },
  {
    entry: {
      kind: "client-state",
      simulationTime: 0,
      clientId: "missing",
      state: "invalid",
    },
    message: 'timeline[0] refers to unknown client "missing".',
  },
  {
    entry: {
      kind: "client-subscription",
      simulationTime: 0,
      clientId: "viewer",
      action: "invalid",
      viewId: "missing",
    },
    message: 'Expected timeline[0].action to be "subscribe" or "unsubscribe".',
  },
  {
    entry: {
      kind: "client-view-check",
      simulationTime: 0,
      clientId: "viewer",
      viewId: "missing",
      expected: null,
    },
    message: 'timeline[0] refers to unknown view "missing".',
  },
  {
    entry: {
      kind: "client-view-check",
      simulationTime: 0,
      clientId: "viewer",
      viewId: "current",
      entityId: "",
      expected: null,
    },
    message: "Expected timeline[0].expected to be an object.",
  },
  {
    entry: {
      kind: "view-check",
      simulationTime: 0,
      viewId: "current",
      entityId: "",
      expected: [],
    },
    message: "Expected timeline[0].entityId to be a non-empty string.",
  },
  {
    entry: {
      kind: "source-event",
      simulationTime: 0,
      sourceId: "missing",
      payload: null,
    },
    message: 'timeline[0] refers to unknown source "missing".',
  },
  {
    entry: {
      kind: "source-event",
      simulationTime: 0,
      sourceId: "feed",
      type: "",
      payload: [],
    },
    message: "Expected timeline[0].payload to be an object.",
  },
];

for (const { entry, message } of invalidEntries) {
  test(`validation precedence: ${message}`, () => {
    const input = scenario();
    input.timeline = [entry];

    assert.throws(() => parseScenario(input), { message });
  });
}

test("client checks require an object while HTTP checks allow null", () => {
  const input = scenario();

  input.timeline = [
    {
      kind: "client-view-check",
      simulationTime: 0,
      clientId: "viewer",
      viewId: "current",
      entityId: "one",
      expected: {},
    },
  ];

  assert.deepEqual(parseScenario(input).timeline, input.timeline);
  input.timeline = [
    {
      kind: "view-check",
      simulationTime: 0,
      viewId: "current",
      entityId: "one",
      expected: null,
    },
  ];

  assert.deepEqual(parseScenario(input).timeline, input.timeline);
});
