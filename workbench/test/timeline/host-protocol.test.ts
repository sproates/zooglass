import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeHandshake,
  decodeResponse,
} from "../../src/timeline/host-protocol.js";

const handshake = {
  protocol: 1,
  fixture: "timeline-proof-v1",
  artifact: "a".repeat(64),
  frameCap: 16 * 1024 * 1024,
  storage: ["memory"],
  protectedAccess: false,
  configurationAdmission: 1,
  documentFormats: ["timeline-simulation/v1"],
  environment: { javaRuntime: "25" },
};
const response = {
  turnId: 2,
  runtimeGeneration: 1,
  timeMs: 10,
  effects: [],
  pendingTasks: 0,
  heldFrames: 0,
};

test("host protocol rejects incomplete capabilities and non-object frames", () => {
  assert.deepEqual(decodeHandshake(handshake), handshake);
  const legacy = {
    ...handshake,
    configurationAdmission: undefined,
    documentFormats: undefined,
  };
  assert.deepEqual(decodeHandshake(legacy), legacy);
  assert.throws(
    () => decodeHandshake({ ...legacy, documentFormats: 42 }),
    /Invalid host protocol/,
  );
  for (const value of [
    null,
    [],
    { ...handshake, documentFormats: undefined },
    { ...handshake, environment: { javaRuntime: 25 } },
  ])
    assert.throws(() => decodeHandshake(value), /Invalid host protocol/);
  for (const value of [
    null,
    [],
    { ...response, pendingTasks: undefined },
    { ...response, heldFrames: -1 },
    { ...response, timeMs: 0.5 },
  ])
    assert.throws(() => decodeResponse(value), /Invalid host protocol/);
});

test("host effects have kind-specific required fields and exact opaque payloads", () => {
  const wire = '{"amount":900719925474099312345678901234567890,"text":"雪"}';
  const effects = [
    { kind: "schedule", task: 1, at: 20, phase: 1, taskKind: "alarm" },
    { kind: "cancel", task: 2 },
    { kind: "state", wire },
    { kind: "receipt", session: "source-1", wire },
    { kind: "handoff", session: "viewer-1", wire },
    { kind: "frame", session: "viewer-1", wire },
    { kind: "close", session: "viewer-1", code: 1000 },
  ];
  assert.deepEqual(decodeResponse({ ...response, effects }).effects, effects);
  for (const effect of [
    { kind: "schedule", task: 1, at: 20, phase: 3, taskKind: "alarm" },
    {
      kind: "schedule",
      task: 1,
      at: Number.MAX_SAFE_INTEGER + 1,
      phase: 1,
      taskKind: "alarm",
    },
    { kind: "cancel" },
    { kind: "state", wire: {} },
    { kind: "receipt", wire },
    { kind: "handoff", session: "viewer-1" },
    { kind: "frame", session: "viewer-1", wire: null },
    { kind: "close", session: "viewer-1", code: -1 },
    { kind: "invented" },
  ])
    assert.throws(
      () => decodeResponse({ ...response, effects: [effect] }),
      /response.effects\[0\]/,
    );
});

test("host configuration and timing diagnostics are validated separately from payloads", () => {
  const configuration = {
    contractVersion: 2,
    storage: "memory",
    documentProfile: "memory-arrival-v1",
  };
  const diagnostics = {
    pauseMillis: 70,
    pauses: [
      {
        site: "state-effect",
        requestedMillis: 70,
        elapsedNanos: 70_000_000,
        virtualMs: 10,
      },
    ],
  };
  assert.deepEqual(
    decodeResponse({ ...response, configuration, diagnostics }),
    { ...response, configuration, diagnostics },
  );
  for (const extra of [
    { configuration: { ...configuration, contractVersion: "2" } },
    { diagnostics: { ...diagnostics, pauses: [null] } },
    {
      diagnostics: {
        ...diagnostics,
        pauses: [{ ...diagnostics.pauses[0], elapsedNanos: -1 }],
      },
    },
  ])
    assert.throws(
      () => decodeResponse({ ...response, ...extra }),
      /Invalid host protocol/,
    );
});

test("SQLite capability requires a native version and snapshots remain protocol-2 opaque wires", () => {
  const sqlite = {
    ...handshake,
    protocol: 2,
    configurationAdmission: undefined,
    memoryLifecycle: 1,
    sqliteLifecycle: 1,
    documentFormats: [],
    storage: ["memory", "sqlite"],
    environment: { javaRuntime: "25", sqliteVersion: "3.51.1" },
  };
  assert.deepEqual(decodeHandshake(sqlite), sqlite);
  for (const changed of [
    { ...sqlite, sqliteLifecycle: 2 },
    { ...sqlite, environment: { javaRuntime: "25" } },
    { ...sqlite, storage: ["memory"] },
    { ...sqlite, storage: ["sqlite"] },
    { ...sqlite, sqliteLifecycle: undefined },
  ])
    assert.throws(() => decodeHandshake(changed), /Invalid host protocol/);
  const wire = '{"amount":900719925474099312345678901234567890}';
  const initialized = {
    ...response,
    monotonicMs: 0,
    wallMillis: 10,
    snapshots: [wire],
  };
  assert.deepEqual(decodeResponse(initialized, 2).snapshots, [wire]);
  assert.throws(
    () => decodeResponse(initialized),
    /snapshots requires protocol 2/,
  );
  for (const snapshots of [null, [1], Array(65).fill(wire)])
    assert.throws(
      () => decodeResponse({ ...initialized, snapshots }, 2),
      /snapshots/,
    );
});
