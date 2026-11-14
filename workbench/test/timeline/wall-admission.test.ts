import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { parseTimelineDocument } from "../../src/timeline/contract.js";
import { canonicalJson } from "../../src/timeline/json.js";
import { parseReplay } from "../../src/timeline/replay-document.js";
import { validateTrace } from "../../src/timeline/trace-contract.js";
import { fixture } from "./document-fixture.js";

const configuration = "{}";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const hash = "a".repeat(64);
const execution = {
  profile: "receipt-age-restart-v1",
  configurationSha256: sha(configuration),
  artifactSha256: hash,
  workbenchSha256: hash,
};
const clock = (id: string, atMs: number, wallMillis: number) => ({
  id,
  atMs,
  kind: "wall-clock-set",
  wallMillis,
});
const stop = { id: "stop", atMs: 10, kind: "service-stop", mode: "abrupt" };
const start = { id: "start", atMs: 10, kind: "service-start" };

function scenario(actions: object[], epochMillis = 100, untilMs = 11) {
  const { document } = fixture();
  return parseTimelineDocument(
    JSON.stringify({
      ...document,
      format: "timeline-simulation/v2",
      clock: { epochMillis },
      untilMs,
      runtime: { ...document.runtime, sha256: sha(configuration) },
      actions,
      assertions: [],
    }),
  );
}

test("wall-clock-set is actorless and follows declaration order among phase-zero controls", () => {
  const doc = scenario([
    stop,
    clock("low", 10, 0),
    start,
    clock("high", 10, 120),
  ]);
  assert.deepEqual(
    doc.admittedActions.map(({ id, actor, phase }) => [id, actor, phase]),
    [
      ["stop", undefined, 0],
      ["low", undefined, 0],
      ["start", undefined, 0],
      ["high", undefined, 0],
    ],
  );
  assert.ok(doc.requiredCapabilities.includes("wall-clock-adjustments"));
  assert.throws(
    () =>
      scenario([{ ...clock("wall", 0, 0), actor: "viewer-logical-source" }]),
    /actor: unknown field/,
  );
  assert.throws(
    () => scenario([{ id: "missing", atMs: 0, kind: "wall-clock-set" }]),
    /wallMillis: required field/,
  );
  for (const wallMillis of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(
      () => scenario([clock("wall", 0, wallMillis)]),
      /wallMillis: expected integer/,
    );
});

test("wall time must stay within safe integer range at every segment endpoint", () => {
  const max = Number.MAX_SAFE_INTEGER;
  assert.doesNotThrow(() =>
    scenario([clock("high", 1, max - 1), clock("reset", 2, 0)]),
  );
  assert.doesNotThrow(() =>
    scenario([clock("high", 10, max), clock("reset", 10, 0)]),
  );
  assert.throws(
    () => scenario([clock("high", 1, max - 1), clock("reset", 3, 0)]),
    /overflows safe integer before the next setting/,
  );
  assert.throws(
    () => scenario([clock("high", 10, max)]),
    /overflows safe integer before the next setting or horizon/,
  );
  assert.throws(
    () => scenario([clock("reset", 0, 0)], max),
    /epochMillis: clock plus horizon overflows/,
  );
});

const runtime = {
  actor: "@runtime",
  connectionGeneration: null,
  runtimeGeneration: null,
  parentId: null,
};
const initialize = {
  ...runtime,
  eventId: "init",
  kind: "runtime-command",
  key: [0, 0, 0, 0],
  data: {
    op: "initialize-document",
    epochMillis: 100,
    configurationSha256: sha(configuration),
  },
};
const initial = {
  ...runtime,
  eventId: "initial",
  parentId: "init",
  kind: "runtime-initialized",
  key: [0, 0, 0, 0],
  runtimeGeneration: 1,
  data: { startTimeMs: 0, wallMillis: 100, monotonicMs: 0, snapshots: [] },
};
const stopped = {
  ...runtime,
  eventId: "stopped",
  kind: "action",
  key: [10, 0, 0, 1],
  runtimeGeneration: 1,
  data: { actionId: "stop", actionKind: "service-stop", mode: "abrupt" },
};
const changed = {
  ...runtime,
  eventId: "changed",
  kind: "action",
  key: [10, 0, 0, 2],
  data: { actionId: "wall", actionKind: "wall-clock-set", wallMillis: 0 },
};
const starting = {
  ...runtime,
  eventId: "starting",
  kind: "action",
  key: [10, 0, 0, 3],
  data: { actionId: "start", actionKind: "service-start" },
};
const restarted = {
  ...runtime,
  eventId: "restarted",
  parentId: "starting",
  runtimeGeneration: 2,
  kind: "runtime-initialized",
  key: [10, 0, 0, 3],
  data: { startTimeMs: 10, wallMillis: 0, monotonicMs: 0, snapshots: [] },
};
const declaration = scenario([stop, clock("wall", 10, 0), start]);

function evidence(records: object[], outcome = "passed") {
  const header = {
    format: "timeline-trace/v2",
    scenarioSha256: sha(declaration.canonical),
    untilMs: 11,
    execution,
  };
  const result = {
    kind: "result",
    outcome,
    eventCount: records.length,
    pendingFutureTasks: 0,
    pendingMessages: 0,
    heldFrames: 0,
  };
  const trace =
    [header, ...records, result]
      .map((record) => canonicalJson(JSON.stringify(record)))
      .join("\n") + "\n";
  return {
    trace,
    run: JSON.stringify({
      format: "timeline-run/v2",
      environment: {},
      outcome,
      execution,
      scenario: declaration.canonical,
      configuration,
      trace,
    }),
  };
}

test("trace initialization uses the preceding declared offset and can have wall time below agenda time", () => {
  const prefix = [initialize, initial, stopped];
  const trace = evidence([...prefix, changed, starting, restarted]);
  assert.equal(validateTrace(trace.trace), trace.trace);
  assert.doesNotThrow(() => parseReplay(trace.run));
  const wrongClock = {
    ...restarted,
    data: { ...restarted.data, wallMillis: 110 },
  };
  assert.throws(
    () =>
      validateTrace(evidence([...prefix, changed, starting, wrongClock]).trace),
    /initialization wall clock/,
  );
  const late = { ...changed, key: [10, 0, 0, 4], runtimeGeneration: 2 };
  assert.doesNotThrow(() =>
    validateTrace(evidence([...prefix, starting, wrongClock, late]).trace),
  );
  assert.throws(
    () => parseReplay(evidence([...prefix, starting, wrongClock, late]).run),
    /runtime action differs from scenario/,
  );
});

test("replay rejects coordinated wall edits and missing runtime actions but accepts genuine failed prefixes", () => {
  const rewritten = { ...changed, data: { ...changed.data, wallMillis: 1 } };
  const matchingClock = {
    ...restarted,
    data: { ...restarted.data, wallMillis: 1 },
  };
  const forged = evidence([
    initialize,
    initial,
    stopped,
    rewritten,
    starting,
    matchingClock,
  ]);
  assert.doesNotThrow(() => validateTrace(forged.trace));
  assert.throws(
    () => parseReplay(forged.run),
    /runtime action differs from scenario/,
  );
  assert.throws(
    () => parseReplay(evidence([initialize, initial]).run),
    /missing runtime actions/,
  );
  assert.doesNotThrow(() =>
    parseReplay(evidence([initialize, initial, stopped], "limit-exceeded").run),
  );
});

test("declared runtime controls are round-zero phase-zero root actions", () => {
  const lateWall = { ...changed, key: [10, 1, 0, 2] };
  const lateStart = { ...starting, key: [10, 1, 0, 3] };
  const lateInitialization = { ...restarted, key: lateStart.key };
  assert.throws(
    () =>
      validateTrace(
        evidence([
          initialize,
          initial,
          stopped,
          lateWall,
          lateStart,
          lateInitialization,
        ]).trace,
      ),
    /round-zero phase-zero root action/,
  );
  const derivedStop = { ...stopped, parentId: "initial" };
  assert.throws(
    () =>
      validateTrace(
        evidence([
          initialize,
          initial,
          derivedStop,
          changed,
          starting,
          restarted,
        ]).trace,
      ),
    /round-zero phase-zero root action/,
  );
});

test("initialization immediately follows the matching start at the complete agenda key", () => {
  const prefix = [initialize, initial, stopped, changed, starting];
  assert.throws(
    () =>
      validateTrace(
        evidence([...prefix, { ...restarted, key: [10, 0, 0, 4] }]).trace,
      ),
    /same agenda key/,
  );
  const unrelated = {
    ...runtime,
    eventId: "unrelated",
    actor: "source",
    key: starting.key,
    kind: "action",
    data: { actionId: "connect", actionKind: "connect" },
  };
  assert.throws(
    () => validateTrace(evidence([...prefix, unrelated, restarted]).trace),
    /immediately followed by initialization/,
  );
  assert.doesNotThrow(() =>
    parseReplay(evidence(prefix, "limit-exceeded").run),
  );
  assert.doesNotThrow(() =>
    validateTrace(evidence(prefix, "infrastructure-failed").trace),
  );
});
