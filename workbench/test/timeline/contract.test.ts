import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalJson,
  parseJson,
  jsonLimits,
} from "../../src/timeline/json.js";
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
      { id: "connect-feed", atMs: 0, kind: "connect", actor: "feed" },
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

test("lossless parsing enforces the expanded byte budget before returning a value", () => {
  // Each expanded number has 4096 bytes. Including commas and brackets,
  // 4095 numbers encode to exactly 16 MiB, despite the compact input.
  const atLimit = "[" + Array(4095).fill("1e4095").join(",") + "]";
  assert.equal(Buffer.byteLength(canonicalJson(atLimit)), jsonLimits.bytes);
  const overLimit = "[" + Array(4096).fill("1e4095").join(",") + "]";
  assert.throws(() => parseJson(overLimit), /canonical byte limit/);
});

test("canonical budgets count UTF-8, escaped strings and structural punctuation exactly", () => {
  for (const raw of [
    ' { "é": ["\\n", "𐀀", null, true, false, -0.00, 1e2] } ',
    ' { "\\u0061": {}, "b": [], "c": "\\/" } ',
  ]) {
    const expected = canonicalJson(raw);
    const bytes = Buffer.byteLength(expected);
    assert.equal(canonicalJson(raw, bytes), expected);
    assert.throws(() => parseJson(raw, bytes - 1), /canonical byte limit/);
  }
  for (const budget of [NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => canonicalJson("0", budget), /canonical byte budget/);
  assert.throws(() => canonicalJson("0", 0), /canonical byte limit/);
});

test("scenario validation preserves payload precision but grants no executable support", () => {
  const raw = JSON.stringify(fixture()).replace(
    '"x":1',
    '"x":9007199254740993',
  );
  const parsed = parseTimelineDocument(raw);
  assert.ok(parsed.canonical.includes("9007199254740993"));
  assert.deepEqual(parsed.requiredCapabilities, [
    "client-lifecycle",
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
    ["unknown field", (v) => Object.assign(v, { unsupported: [] })],
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
        v.links[0].latencyMs = 3600001;
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
      data: {
        actionId: "send",
        actionKind: "source-send",
        publication: "report",
      },
    },
    {
      kind: "receipt",
      eventId: "receipt",
      parentId: "send",
      key: [10, 1, 2, 1],
      actor: "feed",
      runtimeGeneration: 1,
      connectionGeneration: 1,
      data: { envelope: receipt() },
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
  assert.ok(encoded.includes('"status":"applied"'));
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

test("trace byte budget applies to the complete canonical artifact", () => {
  const records = transcript();
  const numbers = "[" + Array(2200).fill("1e4095").join(",") + "]";
  const raw =
    records
      .map((record, index) => {
        if (index === 1 || index === 2)
          return JSON.stringify({
            ...record,
            kind: "state",
            data: { envelope: { ...snapshot(), data: { values: "EXPAND" } } },
          }).replace('"EXPAND"', numbers);
        return JSON.stringify(record);
      })
      .join("\n") + "\n";
  assert.ok(Buffer.byteLength(raw) < jsonLimits.bytes);
  assert.throws(() => validateTrace(raw), /canonical byte limit/);
});

test("a canonical trace may exactly fill its budget including final newline", () => {
  const records = transcript();
  const count = 4094;
  const numbers = "[" + Array(count).fill("1e4095").join(",") + "]";
  const raw =
    records
      .map((record, index) =>
        index === 1
          ? JSON.stringify({
              ...record,
              kind: "state",
              data: {
                envelope: {
                  ...snapshot(),
                  data: { values: "EXPAND", padding: "" },
                },
              },
            }).replace('"EXPAND"', numbers)
          : JSON.stringify(record),
      )
      .join("\n") + "\n";
  // All other spellings keep their byte length when canonicalised.
  const padding =
    jsonLimits.bytes - Buffer.byteLength(raw) - count * (4096 - 6);
  assert.ok(padding > 0);
  const fill = (length: number) =>
    raw.replace('"padding":""', '"padding":"' + "x".repeat(length) + '"');
  assert.equal(
    Buffer.byteLength(validateTrace(fill(padding))),
    jsonLimits.bytes,
  );
  assert.throws(() => validateTrace(fill(padding + 1)), /canonical byte limit/);
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

function lifecycle(actions: object[]) {
  return parseTimelineDocument(JSON.stringify({ ...fixture(), actions }));
}
const connect = (actor = "feed", atMs = 0, id = "connect") => ({
  id,
  atMs,
  kind: "connect",
  actor,
});
const send = (
  kind = "source-send",
  atMs = 10,
  actor = "feed",
  id = "send",
) => ({ id, atMs, kind, actor, publication: "report" });
const control = (kind: string, id = kind, atMs = 0, actor = "viewer") => ({
  id,
  atMs,
  kind,
  actor,
});
const subscribe = (kind = "client-subscribe", id = kind, atMs = 0) => ({
  ...control(kind, id, atMs),
  viewId: "position",
  entityId: "bus",
});

test("lifecycle admission uses time then phase then declaration, retaining generations", () => {
  const admitted = lifecycle([
    send("source-retry", 20, "feed", "retry"),
    connect("feed", 20, "reconnect"),
    { ...control("disconnect", "disconnect", 15, "feed") },
    send(),
    connect("feed", 10),
  ]).admittedActions;
  assert.deepEqual(
    admitted.map((a) => [a.id, a.atMs, a.phase, a.connectionGeneration]),
    [
      ["connect", 10, 0, 1],
      ["send", 10, 2, 1],
      ["disconnect", 15, 0, 1],
      ["reconnect", 20, 0, 2],
      ["retry", 20, 2, 2],
    ],
  );
  assert.ok(admitted.every((a) => a.runtimeGeneration === 1));
  assert.throws(
    () =>
      lifecycle([
        connect(),
        send(),
        control("disconnect", "close", 10, "feed"),
      ]),
    /requires a connected actor/,
  );
});

test("lifecycle rejects impossible connections, retries, subscriptions and writer controls", () => {
  const cases: [object[], RegExp][] = [
    [[send()], /connected/],
    [[connect(), connect("feed", 1, "again")], /disconnected/],
    [[control("disconnect", "disconnect", 0, "feed")], /connected or closing/],
    [[connect(), send("source-retry")], /prior send/],
    [
      [connect(), send(), send("source-send", 20, "feed", "second")],
      /source-retry/,
    ],
    [
      [connect("viewer"), subscribe("client-unsubscribe")],
      /active subscription/,
    ],
    [
      [
        connect("viewer"),
        subscribe(),
        subscribe("client-subscribe", "second", 1),
      ],
      /already active/,
    ],
    [
      [
        connect("viewer"),
        control("writer-stall"),
        control("writer-stall", "twice", 1),
      ],
      /already stalled/,
    ],
    [
      [connect("viewer"), { ...control("writer-release"), fail: false }],
      /stalled writer/,
    ],
    [
      [
        connect("viewer"),
        control("writer-stall"),
        { ...control("writer-release", "release", 1), fail: true },
        subscribe("client-subscribe", "subscribe", 2),
      ],
      /connected/,
    ],
  ];
  for (const [actions, error] of cases)
    assert.throws(() => lifecycle(actions), error);
});

test("disconnect clears generation-local subscriptions and writer state", () => {
  const base = [
    connect("viewer"),
    subscribe(),
    control("writer-stall", "stall", 1),
    control("disconnect", "close", 2),
    connect("viewer", 3, "reconnect"),
  ];
  assert.throws(
    () => lifecycle([...base, subscribe("client-unsubscribe", "remove", 4)]),
    /active subscription/,
  );
  assert.throws(
    () =>
      lifecycle([
        ...base,
        { ...control("writer-release", "release", 4), fail: false },
      ]),
    /stalled writer/,
  );
  assert.equal(
    lifecycle([
      ...base,
      subscribe("client-subscribe", "resubscribe", 4),
    ]).admittedActions.at(-1)?.connectionGeneration,
    2,
  );
  const failed = [
    connect("viewer"),
    control("writer-stall"),
    { ...control("writer-release", "release", 1), fail: true },
    control("disconnect", "close", 2),
    connect("viewer", 3, "reconnect"),
  ];
  assert.equal(
    lifecycle(failed).admittedActions.at(-1)?.connectionGeneration,
    2,
  );
});

function receipt() {
  return {
    status: "applied",
    reason: "memory",
    stream: { sourceId: "feed", epoch: "v1", sourceEntityId: "bus" },
    publicationSequence: 1,
    version: 1,
    changedViews: [],
    targets: [],
  };
}
function snapshot() {
  return {
    data: {},
    entityId: "bus",
    viewId: "position",
    version: 0,
    provenance: {},
    status: {
      publication: "partial",
      missingFields: ["position"],
      missingRequiredFields: [],
      fields: {},
      inputs: {},
    },
  };
}
test("assertions require complete typed envelopes and preserve exact long counters", () => {
  const document = {
    ...fixture(),
    assertions: [
      {
        id: "receipt",
        atMs: 10,
        kind: "source-receipts",
        actor: "feed",
        expected: [receipt()],
      },
    ],
  };
  const raw = JSON.stringify(document).replaceAll(
    '"version":1',
    '"version":9223372036854775807',
  );
  assert.ok(
    parseTimelineDocument(raw).canonical.includes("9223372036854775807"),
  );
  assert.throws(
    () =>
      parseTimelineDocument(
        raw.replace("9223372036854775807", "9223372036854775808"),
      ),
    /signed-64-bit/,
  );
  assert.throws(
    () =>
      parseTimelineDocument(
        JSON.stringify({
          ...document,
          assertions: [
            { ...document.assertions[0], expected: [{ status: "applied" }] },
          ],
        }),
      ),
    /required field/,
  );
  const client = {
    ...document,
    assertions: [
      {
        id: "frames",
        atMs: 10,
        kind: "client-frames",
        actor: "viewer",
        expected: [
          { ...snapshot(), type: "view-update", publicationSequences: {} },
          {
            type: "subscribed",
            viewId: "position",
            entityId: "bus",
            recovery: "freshSnapshot",
          },
        ],
      },
    ],
  };
  parseTimelineDocument(JSON.stringify(client));
  assert.throws(
    () =>
      parseTimelineDocument(
        JSON.stringify(client).replace('"version":0', '"version":0.1'),
      ),
    /signed-64-bit/,
  );
});

test("event data is kind-specific, closed and retains complete semantic envelopes", () => {
  const event = transcript()[1];
  const check = (kind: string, data: object) =>
    validateTrace(
      lines([
        transcript()[0],
        { ...event, kind, data },
        { ...transcript().at(-1), eventCount: 1 },
      ]),
    );
  for (const [kind, data] of [
    ["action", { actionId: "connect", actionKind: "connect" }],
    [
      "scheduled",
      { taskId: "alarm", atMs: 30, phase: 1, taskKind: "freshness" },
    ],
    ["cancelled", { taskId: "alarm" }],
    [
      "delivered",
      { messageId: "message", channel: "source-receipt", envelope: receipt() },
    ],
    [
      "dropped",
      {
        messageId: "message",
        channel: "source-receipt",
        envelope: receipt(),
        reason: "fixture-loss",
      },
    ],
    ["receipt", { envelope: receipt() }],
    ["state", { envelope: snapshot() }],
    [
      "frame",
      {
        envelope: { type: "unsubscribed", viewId: "position", entityId: "bus" },
      },
    ],
    [
      "assertion",
      {
        assertionId: "expected",
        assertionKind: "source-receipts",
        atMs: 10,
        passed: true,
        expected: [receipt()],
        actual: [receipt()],
      },
    ],
  ] as [string, object][]) {
    assert.doesNotThrow(() => check(kind, data), kind);
    assert.throws(() => check(kind, {}), /required field|expected nonblank/);
    assert.throws(() => check(kind, { ...data, extra: true }), /unknown field/);
  }
  assert.throws(
    () =>
      check("scheduled", {
        taskId: "alarm",
        atMs: 9,
        phase: 1,
        taskKind: "freshness",
      }),
    /expected integer/,
  );
  assert.throws(
    () => check("frame", { envelope: receipt() }),
    /expected nonblank/,
  );
  assert.throws(
    () =>
      check("receipt", {
        envelope: {
          ...receipt(),
          targets: [
            {
              viewId: "v",
              entityId: "e",
              status: "accepted",
              reason: null,
              changedFields: [],
              fields: [
                {
                  field: "f",
                  status: "accepted",
                  reason: null,
                  changed: "true",
                },
              ],
            },
          ],
        },
      }),
    /expected boolean/,
  );
});

test("assertion records cannot mislabel exact comparison or hide failures in a passing result", () => {
  const assertion = {
    ...transcript()[1],
    kind: "assertion",
    data: {
      assertionId: "receipts",
      assertionKind: "source-receipts",
      atMs: 10,
      passed: true,
      expected: [],
      actual: [receipt()],
    },
  };
  const result = { ...transcript().at(-1), eventCount: 1 };
  assert.throws(
    () => validateTrace(lines([transcript()[0], assertion, result])),
    /disagrees/,
  );
  assertion.data.passed = false;
  assert.throws(
    () => validateTrace(lines([transcript()[0], assertion, result])),
    /failed assertion/,
  );
  assert.doesNotThrow(() =>
    validateTrace(
      lines([
        transcript()[0],
        assertion,
        { ...result, outcome: "assertion-failed" },
      ]),
    ),
  );
});

test("receipt schemas retain nullable rejection targets and unmapped entity identities", () => {
  const envelopes = [
    {
      status: "rejected",
      reason: "invalidEnvelope",
      stream: null,
      publicationSequence: null,
      version: null,
      changedViews: [],
      targets: null,
    },
    {
      ...receipt(),
      targets: [
        {
          viewId: "position",
          entityId: null,
          status: "rejected",
          reason: "unknownEntityMapping",
          changedFields: [],
          fields: [],
        },
      ],
    },
    {
      ...receipt(),
      status: "failed",
      reason: "processingFailure",
      version: null,
      targets: [],
    },
  ];
  const document = {
    ...fixture(),
    assertions: [
      {
        id: "receipts",
        atMs: 10,
        kind: "source-receipts",
        actor: "feed",
        expected: envelopes,
      },
    ],
  };
  assert.doesNotThrow(() => parseTimelineDocument(JSON.stringify(document)));
  assert.throws(
    () =>
      parseTimelineDocument(
        JSON.stringify(document).replace('"entityId":null', '"entityId":false'),
      ),
    /expected nonblank/,
  );
});
