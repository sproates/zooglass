import assert from "node:assert/strict";
import test from "node:test";
import {
  capabilities,
  lifecycleCapabilities,
  lifecycleFormat,
  parseTimelineDocument,
  requireExecutionCapabilities,
} from "../../src/timeline/contract.js";
import { executionSettings } from "../../src/timeline/document-profile.js";
import { eventData } from "../../src/timeline/event-schema.js";
import { parseJson } from "../../src/timeline/json.js";
import { client, fixture, source } from "./document-fixture.js";

const stop = (atMs = 10, id = "stop") => ({
  id,
  atMs,
  kind: "service-stop",
  mode: "abrupt",
});
const start = (atMs = 20, id = "start") => ({
  id,
  atMs,
  kind: "service-start",
});
const connect = (actor = source, atMs = 0, id = "connect") => ({
  id,
  atMs,
  kind: "connect",
  actor,
});
const send = (atMs = 10, id = "send", kind = "source-send") => ({
  id,
  atMs,
  kind,
  actor: source,
  publication: "report-1",
});
const subscribe = (atMs: number, id: string, kind = "client-subscribe") => ({
  id,
  atMs,
  kind,
  actor: client,
  viewId: "stock-view",
  entityId: "sku-4",
});
const policy = {
  action: "send",
  maxAttempts: 3,
  receiptTimeoutMs: 10,
  retryIntervalMs: 0,
  unavailableRetryIntervalMs: 30,
};

function admit(actions: object[], overrides: Record<string, unknown> = {}) {
  const { document } = fixture();
  return parseTimelineDocument(
    JSON.stringify({
      ...document,
      format: lifecycleFormat,
      runtime: { ...document.runtime, sha256: "a".repeat(64) },
      actions,
      assertions: [],
      ...overrides,
    }),
  );
}

test("v2 admits actorless service controls with same-time declaration order and no preassigned connection generations", () => {
  const parsed = admit([send(20), stop(20), start(20), connect(source, 20)]);
  assert.equal(parsed.format, lifecycleFormat);
  assert.deepEqual(
    parsed.admittedActions.map(({ id, kind, phase, actor }) => [
      id,
      kind,
      phase,
      actor,
    ]),
    [
      ["stop", "service-stop", 0, undefined],
      ["start", "service-start", 0, undefined],
      ["connect", "connect", 0, source],
      ["send", "source-send", 2, source],
    ],
  );
  assert.ok(
    parsed.admittedActions.every(
      (action) =>
        !Object.hasOwn(action, "connectionGeneration") &&
        !Object.hasOwn(action, "runtimeGeneration"),
    ),
  );
  assert.throws(
    () => requireExecutionCapabilities(parsed, capabilities),
    /memory-lifecycle/,
  );
  requireExecutionCapabilities(parsed, lifecycleCapabilities);
});

test("v2 validates each chronological lifecycle transition and counts the implicit generation", () => {
  assert.doesNotThrow(() => admit([start(), stop()]));
  assert.throws(
    () => admit([start(10), stop(10)]),
    /requires a stopped service/,
  );
  assert.throws(
    () => admit([stop(), stop(11, "again")]),
    /requires a running service/,
  );
  const actions = Array.from({ length: 15 }, (_, index) => [
    stop(index, `stop-${index}`),
    start(index, `start-${index}`),
  ]).flat();
  assert.doesNotThrow(() => admit(actions));
  assert.throws(
    () => admit([...actions, stop(15), start(15)]),
    /at most 16 runtime generations/,
  );
});

test("v2 never admits service controls or recovery fields through the v1 contract", () => {
  assert.throws(
    () => admit([stop()], { format: "timeline-simulation/v1" }),
    /\.kind: supported values/,
  );
  assert.throws(
    () => admit([{ ...stop(), actor: source }]),
    /\.actor: unknown field/,
  );
  assert.throws(
    () => admit([stop(), { ...start(), mode: "orderly" }]),
    /\.mode: unknown field/,
  );
  assert.throws(
    () => admit([{ ...stop(), mode: "crash" }]),
    /\.mode: supported values/,
  );
  assert.throws(
    () => admit([{ id: "stop", atMs: 10, kind: "service-stop" }]),
    /\.mode: required field/,
  );
  assert.throws(
    () =>
      admit([], { format: "timeline-simulation/v1", observationTargets: [] }),
    /observationTargets: unknown field/,
  );
  assert.throws(
    () =>
      admit([{ id: "wall", atMs: 1, kind: "wall-clock-set", wallMillis: 5 }], {
        format: "timeline-simulation/v1",
      }),
    /\.kind: supported values/,
  );
  const { document } = fixture();
  assert.throws(
    () =>
      admit([], {
        format: "timeline-simulation/v1",
        runtime: {
          ...document.runtime,
          sha256: "a".repeat(64),
          storage: "sqlite",
        },
      }),
    /storage: supported values: memory/,
  );
});

test("stop clears live connection and subscription admission state while retaining send intent", () => {
  const actions = [
    connect(),
    connect(client, 0, "viewer"),
    subscribe(0, "initial"),
    send(5),
    stop(),
    start(),
  ];
  assert.throws(
    () => admit([...actions, send(25, "retry", "source-retry")]),
    /requires a connected actor/,
  );
  assert.throws(
    () =>
      admit([
        ...actions,
        connect(client, 21, "new-viewer"),
        subscribe(22, "remove", "client-unsubscribe"),
      ]),
    /requires an active subscription/,
  );
  const parsed = admit([
    ...actions,
    connect(source, 12, "offline-connect"),
    send(15, "offline-retry", "source-retry"),
    connect(source, 21, "new-source"),
    connect(client, 21, "new-viewer"),
    subscribe(22, "new-subscription"),
    send(23, "after-restart", "source-retry"),
  ]);
  assert.equal(parsed.admittedActions.at(-1)?.id, "after-restart");
  assert.throws(
    () => admit([stop(), send(15, "retry-first", "source-retry")]),
    /requires a prior send/,
  );
  assert.throws(
    () => admit([stop(), subscribe(15, "offline-subscription")]),
    /requires a connected actor/,
  );
});

test("v2 policies require an independent bounded downtime retry interval", () => {
  const actions = [connect(), stop(5), start(10), send(10)];
  assert.deepEqual(admit(actions, { retries: [policy] }).retryPolicies, [
    { ...policy, actor: source, publication: "report-1" },
  ]);
  assert.throws(() => admit(actions), /requires a connected actor/);
  assert.throws(
    () => admit([connect(source, 11), send(10)], { retries: [policy] }),
    /connect must precede/,
  );
  assert.throws(
    () =>
      admit(actions, {
        retries: [{ ...policy, unavailableRetryIntervalMs: undefined }],
      }),
    /unavailableRetryIntervalMs: required field/,
  );
  for (const unavailableRetryIntervalMs of [-1, 0.5, 3_600_001])
    assert.throws(
      () =>
        admit(actions, {
          retries: [{ ...policy, unavailableRetryIntervalMs }],
        }),
      /unavailableRetryIntervalMs: expected integer/,
    );
  assert.equal(
    admit([stop(0), connect(), send()], {
      retries: [{ ...policy, unavailableRetryIntervalMs: 0 }],
    }).retryPolicies[0].unavailableRetryIntervalMs,
    0,
  );
  assert.throws(
    () =>
      admit([connect(), send()], {
        format: "timeline-simulation/v1",
        retries: [policy],
      }),
    /unavailableRetryIntervalMs: unknown field/,
  );
  assert.throws(
    () =>
      executionSettings(
        admit(actions, { retries: [{ ...policy, maxAttempts: 10 }] }),
        "{}",
      ),
    /ten connection generations/,
  );
});

test("lifecycle trace data is versioned, closed and carries only actual initialization clocks", () => {
  const initialized = {
    startTimeMs: 20,
    wallMillis: 1000020,
    monotonicMs: 0,
    snapshots: [],
  };
  const validate = (kind: string, data: object, version: 1 | 2 = 2) =>
    eventData(kind, parseJson(JSON.stringify(data)), "event", 20, 30, version);
  validate("runtime-initialized", initialized);
  validate("action", {
    actionId: "stop",
    actionKind: "service-stop",
    mode: "orderly",
  });
  validate("connection-outcome", { outcome: "connection-unavailable" });
  validate("attempt-outcome", {
    publication: "report-1",
    attempt: 1,
    outcome: "connection-unavailable",
  });
  assert.throws(
    () => validate("runtime-initialized", { ...initialized, startTimeMs: 19 }),
    /differs from agenda key/,
  );
  assert.throws(
    () => validate("runtime-initialized", { ...initialized, monotonicMs: 1 }),
    /monotonicMs: expected integer 0\.\.0/,
  );
  assert.throws(
    () => validate("runtime-initialized", { ...initialized, snapshots: [{}] }),
    /snapshots\[0\]\.data: required field/,
  );
  assert.throws(
    () =>
      validate("action", { actionId: "start", actionKind: "service-start" }, 1),
    /actionKind: supported values/,
  );
  assert.throws(
    () =>
      validate("connection-outcome", {
        outcome: "connection-unavailable",
        attempt: 1,
      }),
    /attempt: unknown field/,
  );
});
