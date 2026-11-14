import assert from "node:assert/strict";
import test from "node:test";
import { canonicalJson } from "../../src/timeline/json.js";
import { validateTrace } from "../../src/timeline/trace-contract.js";
import { epoch } from "./document-fixture.js";
import { installed } from "./sqlite-document-fixture.js";

const target = { viewId: "stock-view", entityId: "sku-4" };
const hash = "a".repeat(64);
const expected = { outcome: "runtime-unavailable" };
const header = {
  format: "timeline-trace/v2",
  scenarioSha256: hash,
  untilMs: 1,
  execution: {
    profile: "receipt-age-restart-v1",
    artifactSha256: hash,
    configurationSha256: hash,
    workbenchSha256: hash,
  },
};

const runtimeEvent = {
  actor: "@runtime",
  connectionGeneration: null,
  runtimeGeneration: null,
  key: [0, 0, 0, 0],
  parentId: null,
};
const prefix = [
  {
    ...runtimeEvent,
    eventId: "initialize",
    kind: "runtime-command",
    data: {
      op: "initialize-document",
      configurationSha256: hash,
      epochMillis: epoch,
    },
  },
  {
    ...runtimeEvent,
    eventId: "initialized",
    parentId: "initialize",
    kind: "runtime-initialized",
    runtimeGeneration: 1,
    data: {
      startTimeMs: 0,
      monotonicMs: 0,
      wallMillis: epoch,
      snapshots: [installed()],
    },
  },
  {
    ...runtimeEvent,
    eventId: "stop",
    key: [1, 0, 0, 1],
    kind: "action",
    runtimeGeneration: 1,
    data: { actionId: "stop", actionKind: "service-stop", mode: "abrupt" },
  },
  {
    ...runtimeEvent,
    eventId: "observation",
    key: [1, 0, 2, 2],
    kind: "runtime-observation",
    causes: ["stop"],
    data: { ...target, ...expected },
  },
];
const assertion = {
  ...runtimeEvent,
  eventId: "assertion",
  parentId: "observation",
  key: [1, 0, 2, 2],
  kind: "assertion",
  data: {
    assertionId: "offline",
    assertionKind: "runtime-snapshot",
    atMs: 1,
    passed: true,
    expected,
    actual: expected,
    ...target,
  },
};

function trace(events: object[], outcome = "passed") {
  return (
    [
      ...[header],
      ...events,
      {
        kind: "result",
        outcome,
        eventCount: events.length,
        pendingFutureTasks: 0,
        pendingMessages: 0,
        heldFrames: 0,
      },
    ]
      .map((record) => canonicalJson(JSON.stringify(record)))
      .join("\n") + "\n"
  );
}

test("a runtime snapshot assertion and observation must share the complete agenda key", () => {
  assert.doesNotThrow(() =>
    validateTrace(trace([...prefix, assertion]), [target], "sqlite"),
  );
  const changedRound = { ...assertion, key: [1, 1, 2, 2] };
  assert.throws(
    () => validateTrace(trace([...prefix, changedRound]), [target], "sqlite"),
    /same agenda key/,
  );
});

test("same-key records cannot intervene between a runtime observation and its assertion", () => {
  const unrelated = {
    ...runtimeEvent,
    eventId: "connect",
    actor: "source",
    key: assertion.key,
    kind: "action",
    data: { actionId: "offline-connect", actionKind: "connect" },
  };
  assert.throws(
    () =>
      validateTrace(
        trace([...prefix, unrelated, assertion]),
        [target],
        "sqlite",
      ),
    /immediately followed/,
  );
  assert.doesNotThrow(() =>
    validateTrace(trace(prefix, "limit-exceeded"), [target], "sqlite"),
  );
});
