import assert from "node:assert/strict";
import test from "node:test";
import { canonicalJson } from "../../src/timeline/json.js";
import {
  parseTimelineDocument,
  requireExecutionCapabilities,
} from "../../src/timeline/contract.js";
import { validateTrace } from "../../src/timeline/trace-contract.js";
import { assessLegacyScenario } from "../../src/timeline/compatibility.js";
import { parseScenario } from "../../src/scenario/scenario.js";

function fixture() {
  return {
    format: "timeline-simulation/v1",
    id: "receipt-example",
    clock: { epochMillis: 1000000 },
    seed: "0".repeat(64),
    runtime: {
      configuration: "runtime.json",
      sha256: "a".repeat(64),
      storage: "memory",
      access: "unprotected",
      initialState: "empty",
    },
    actors: [
      { id: "feed", role: "source" },
      { id: "viewer", role: "client" },
    ],
    links: [
      { actor: "feed", latencyMs: 0 },
      { actor: "viewer", latencyMs: 0 },
    ],
    publications: [
      {
        id: "report",
        body: {
          sourceId: "feed",
          epoch: "v1",
          publicationSequence: 1,
          type: "position",
          sourceEntityId: "bus",
          payload: { x: 1 },
        },
      },
    ],
    actions: [
      {
        id: "send",
        atMs: 10,
        kind: "source-send",
        actor: "feed",
        publication: "report",
      },
    ],
    assertions: [
      {
        id: "no-frames",
        atMs: 9,
        kind: "client-frames",
        actor: "viewer",
        expected: [],
      },
    ],
    limits: {
      turns: 2000,
      rounds: 100,
      queuedEvents: 1000,
      pendingMessages: 1000,
      traceBytes: 1048576,
    },
    untilMs: 110,
    end: { pendingFutureTasks: "forbid", pendingMessages: 0, heldFrames: 0 },
  };
}

test("canonical vectors preserve exact numbers, array order and Unicode code-point keys", () => {
  assert.equal(
    canonicalJson(
      '{"z":-0,"n":9007199254740993,"d":1.0000000000000000001,"a":[1e0,0.0100,1e-3]}',
    ),
    '{"a":[1,0.01,0.001],"d":1.0000000000000000001,"n":9007199254740993,"z":0}',
  );
  assert.equal(canonicalJson('{"𐀀":1,"":2}'), '{"":2,"𐀀":1}');
  assert.equal(
    canonicalJson('{"b":"\\n\\u0061","a":null}'),
    '{"a":null,"b":"\\na"}',
  );
  assert.equal(canonicalJson("1e4095").length, 4096);
});

test("reject ambiguous JSON and bounded encoding violations", () => {
  for (const raw of [
    '{"a":1,"\\u0061":2}',
    '{"x":{"a":1,"a":2}}',
    "[1,]",
    '{"a":1,}',
    "01",
    "NaN",
    "true false",
    "1e4096",
    "1e-4096",
    '"\\ud800"',
    '"\\udc00"',
    "[".repeat(65) + "0" + "]".repeat(65),
  ])
    assert.throws(() => canonicalJson(raw), undefined, raw.slice(0, 100));
  assert.equal(canonicalJson('{"__proto__":1}'), '{"__proto__":1}');
});

test("scenario validation preserves payload precision but grants no executable support", () => {
  const raw = JSON.stringify(fixture()).replace(
    '"x":1',
    '"x":9007199254740993',
  );
  const parsed = parseTimelineDocument(raw);
  assert.ok(parsed.canonical.includes("9007199254740993"));
  assert.deepEqual(parsed.requiredCapabilities, [
    "memory",
    "observations",
    "source-publication",
  ]);
  assert.throws(
    () => requireExecutionCapabilities(parsed),
    /unsupported-execution/,
  );
});

test("reject unknown keys, identities, unsupported capabilities and unsafe limits", () => {
  const cases: [string, (value: ReturnType<typeof fixture>) => void][] = [
    ["unknown field", (v) => Object.assign(v, { faults: [] })],
    [
      "supported values",
      (v) => {
        v.runtime.storage = "sqlite";
      },
    ],
    [
      "supported values",
      (v) => {
        v.runtime.access = "protected";
      },
    ],
    [
      "supported values",
      (v) => {
        v.actions[0].kind = "view-definition";
      },
    ],
    [
      "unknown identity",
      (v) => {
        v.actions[0].actor = "missing";
      },
    ],
    [
      "unknown identity",
      (v) => {
        v.actions[0].publication = "missing";
      },
    ],
    [
      "duplicate identity",
      (v) => {
        v.assertions[0].id = "send";
      },
    ],
    [
      "expected integer",
      (v) => {
        v.actions[0].atMs = 111;
      },
    ],
    [
      "expected integer",
      (v) => {
        v.limits.turns = 0;
      },
    ],
    [
      "expected integer",
      (v) => {
        v.links[0].latencyMs = 1;
      },
    ],
    [
      "missing bidirectional",
      (v) => {
        v.links.pop();
      },
    ],
  ];
  for (const [message, change] of cases) {
    const value = fixture();
    change(value);
    assert.throws(
      () => parseTimelineDocument(JSON.stringify(value)),
      new RegExp(message),
    );
  }
  assert.throws(
    () =>
      parseTimelineDocument(
        JSON.stringify(fixture()).replace(
          '"atMs":10',
          '"atMs":9.999999999999999999999',
        ),
      ),
    /expected integer/,
  );
});

function transcript() {
  return [
    {
      format: "timeline-trace/v1",
      scenarioSha256: "0".repeat(64),
      untilMs: 20,
    },
    {
      kind: "action",
      eventId: "send",
      parentId: null,
      key: [10, 0, 2, 0],
      actor: "feed",
      runtimeGeneration: 1,
      connectionGeneration: 1,
      data: { publication: "report" },
    },
    {
      kind: "receipt",
      eventId: "receipt",
      parentId: "send",
      key: [10, 1, 2, 1],
      actor: "feed",
      runtimeGeneration: 1,
      connectionGeneration: 1,
      data: { status: "applied", version: 1 },
    },
    {
      kind: "result",
      outcome: "passed",
      eventCount: 2,
      pendingFutureTasks: 0,
      pendingMessages: 0,
      heldFrames: 0,
    },
  ];
}
const lines = (records: unknown[]) =>
  records.map((r) => JSON.stringify(r)).join("\n") + "\n";
test("trace contract retains ordered semantic effects and requires completion", () => {
  const raw = lines(transcript());
  const encoded = validateTrace(raw);
  assert.equal(validateTrace(encoded), encoded);
  assert.ok(encoded.includes('"status":"applied","version":1'));
  assert.throws(() => validateTrace(lines(transcript().slice(0, -1))));
  assert.throws(
    () =>
      validateTrace(raw.replace('"parentId":"send"', '"parentId":"future"')),
    /parent/,
  );
  assert.throws(
    () => validateTrace(raw.replace('"eventId":"receipt"', '"eventId":"send"')),
    /duplicate/,
  );
  assert.throws(
    () => validateTrace(raw.replace("[10,1,2,1]", "[9,1,2,1]")),
    /decrease/,
  );
  assert.throws(
    () => validateTrace(raw.replace('"eventCount":2', '"eventCount":3')),
    /count/,
  );
  assert.throws(
    () => validateTrace(raw.replace('"heldFrames":0', '"heldFrames":1')),
    /passing result/,
  );
});

test("legacy assessment exposes interleaved same-time checks and transient clients", () => {
  const source = {
    kind: "source-event",
    simulationTime: 10,
    sourceId: "feed",
    type: "position",
    epoch: "run",
    publicationSequence: 1,
    entityId: "bus",
    payload: {},
  };
  const scenario = parseScenario({
    name: "interleaved",
    sources: [{ id: "feed", name: "Feed" }],
    clients: [{ id: "viewer", name: "Viewer", initialState: "connecting" }],
    views: [
      {
        id: "position",
        fields: { position: [{ sourceId: "feed", type: "position" }] },
      },
    ],
    timeline: [
      source,
      {
        kind: "view-check",
        simulationTime: 10,
        viewId: "position",
        entityId: "bus",
        expected: null,
      },
      { ...source, publicationSequence: 2 },
    ],
  });
  const report = assessLegacyScenario(scenario);
  assert.equal(report.unchangedExecutionSupported, false);
  assert.equal(report.kinds["source-event"], 2);
  assert.ok(report.issues.some((i) => i.reason.includes("check precedes")));
  assert.ok(report.issues.some((i) => i.reason.includes("burst")));
  assert.ok(report.issues.some((i) => i.reason.includes("transient")));
});
