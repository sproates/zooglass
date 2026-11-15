import assert from "node:assert/strict";
import test from "node:test";
import { Bridge } from "../../src/timeline/bridge.js";
import {
  probeLifecycle,
  requiredConfigurationProfile,
} from "../../src/timeline/admission.js";
import { parseTimelineDocument } from "../../src/timeline/contract.js";
import { decodeHandshake } from "../../src/timeline/host-protocol.js";
import {
  orderProfile,
  orderRestartProfile,
} from "../../src/timeline/evidence-versions.js";
import { action } from "./document-fixture.js";
import { metadataJson } from "../../src/timeline/semantic-trace.js";
import { TraceControls } from "../../src/timeline/trace-controls.js";
import type { TraceEvent } from "../../src/timeline/trace-generations.js";
import { object } from "../../src/timeline/validation.js";
import {
  control,
  controlActor,
  orderDocument,
} from "./order-document-fixture.js";

const parse = (document: unknown) =>
  parseTimelineDocument(JSON.stringify(document));

test("a stopped generation cannot replace a cancelled request with delivery at the same timestamp", () => {
  for (const mode of ["orderly", "abrupt"]) {
    const event = (
      id: string,
      kind: string,
      data: unknown,
      parent: string | null = null,
    ): TraceEvent => ({
      id,
      kind,
      data: object(metadataJson(data), "data"),
      parent,
      causes: [],
      actor: controlActor,
      runtimeGeneration: 1,
      connectionGeneration: 1,
      timeMs: 10,
      key: [10, 0, 2, 0],
    });
    const trace = new TraceControls(orderRestartProfile);
    const prefix = [
      event("send", "action", {
        actionId: "send",
        actionKind: "progress-send",
        control,
      }),
      event(
        "outbound",
        "link-send",
        {
          messageId: "request",
          channel: "progress-request",
          envelope: control,
          deliverAtMs: 13,
        },
        "send",
      ),
    ];
    for (const entry of prefix) trace.accept(entry, entry.id);
    const stop = event("stop", "action", {
      actionId: "stop",
      actionKind: "service-stop",
      mode,
    });
    stop.actor = "@runtime";
    stop.connectionGeneration = null;
    stop.timeMs = 13;
    stop.key = [13, 0, 0, 1];
    trace.accept(stop, "stop");
    prefix.push(stop);
    const dropped = event(
      "cancel",
      "dropped",
      {
        messageId: "request",
        channel: "progress-request",
        envelope: control,
        reason: "connection-closed",
      },
      "stop",
    );
    dropped.timeMs = 13;
    dropped.key = stop.key;
    dropped.causes = ["outbound"];
    trace.accept(dropped, "cancel");
    trace.finish("passed");
    const delivery = event(
      "forged",
      "delivered",
      { messageId: "request", channel: "progress-request", envelope: control },
      "outbound",
    );
    delivery.timeMs = 13;
    delivery.key = [13, 0, 2, 2];
    const replaced = new TraceControls(orderRestartProfile);
    for (const entry of prefix) replaced.accept(entry, entry.id);
    assert.throws(
      () => replaced.accept(delivery, "forged"),
      /cannot use a closed connection generation/,
    );
  }
});
function document() {
  const base = orderDocument();
  base.runtime.sha256 = "a".repeat(64);
  base.runtime.profile = orderRestartProfile;
  return {
    ...base,
    actions: [
      ...base.actions,
      { id: "stop", atMs: 17, kind: "service-stop", mode: "abrupt" },
      { id: "restart", atMs: 20, kind: "service-start" },
      action("reconnect", 21, "connect", controlActor),
      action("repeat", 22, "progress-send", controlActor, { control }),
    ],
  };
}

test("Order lifecycle is a separate v2 SQLite execution profile mapped to the existing configuration boundary", () => {
  const input = document();
  const admitted = parse(input);
  assert.equal(admitted.profile, orderRestartProfile);
  assert.equal(requiredConfigurationProfile(admitted), orderProfile);
  assert.throws(
    () =>
      parse({ ...input, runtime: { ...input.runtime, profile: orderProfile } }),
    /does not support runtime lifecycle/,
  );
  assert.throws(
    () => parse({ ...input, format: "timeline-simulation/v1" }),
    /profile: unknown field/,
  );
  assert.throws(
    () => parse({ ...input, runtime: { ...input.runtime, storage: "memory" } }),
    /requires SQLite storage/,
  );
  assert.throws(
    () =>
      parse({
        ...input,
        actions: [
          ...input.actions,
          { id: "wall", atMs: 23, kind: "wall-clock-set", wallMillis: 1000 },
        ],
      }),
    /does not support wall clock/,
  );
  assert.throws(
    () =>
      parse({
        ...input,
        actions: [
          ...input.actions,
          action("downtime", 18, "progress-send", controlActor, { control }),
        ],
      }),
    /requires a connected actor/,
  );
  assert.throws(
    () =>
      parse({
        ...input,
        actions: input.actions.filter((entry) => entry.id !== "reconnect"),
      }),
    /requires a connected actor/,
  );
  assert.throws(
    () =>
      parse({
        ...input,
        actions: [
          ...input.actions,
          action("offline-connect", 18, "connect", controlActor),
          action("offline-control", 19, "progress-send", controlActor, {
            control,
          }),
        ],
      }),
    /requires a connected actor/,
  );
});

test("Order lifecycle handshake depends on protocol two, SQLite and ordinary Order support", () => {
  const handshake = {
    protocol: 2,
    fixture: "timeline-proof-v1",
    artifact: "a".repeat(64),
    frameCap: 1024,
    storage: ["memory", "sqlite"],
    protectedAccess: false,
    memoryLifecycle: 1,
    sqliteLifecycle: 1,
    sqliteOrder: 1,
    sqliteOrderLifecycle: 1,
    documentFormats: [],
    environment: { sqliteVersion: "3" },
  };
  assert.doesNotThrow(() => decodeHandshake(handshake));
  for (const change of [
    { protocol: 1 },
    { sqliteOrder: undefined },
    { sqliteLifecycle: undefined },
    { storage: ["memory"] },
    { sqliteOrderLifecycle: 0 },
    { sqliteOrderLifecycle: 2 },
    { sqliteOrderLifecycle: "1" },
  ])
    assert.throws(() => decodeHandshake({ ...handshake, ...change }));
});

test("old prepared Order support cannot admit lifecycle and capability failure closes the probe before commands", async (t) => {
  let commands = 0,
    closed = 0;
  const bridge = {
    memoryLifecycle: 1,
    sqliteLifecycle: 1,
    sqliteOrder: 1,
    sqliteOrderLifecycle: 0,
    command() {
      commands++;
    },
    async close() {
      closed++;
    },
    environment: { javaRuntime: "25", sqliteVersion: "3" },
  };
  t.mock.method(Bridge, "open", async () => ({ artifact: "artifact", bridge }));
  await assert.rejects(
    probeLifecycle("unused", "artifact", parse(document())),
    /does not support SQLite Order lifecycle/,
  );
  const ordinary = document();
  ordinary.runtime.profile = orderProfile;
  ordinary.actions = ordinary.actions.slice(0, 2);
  assert.deepEqual(
    await probeLifecycle("unused", "artifact", parse(ordinary)),
    bridge.environment,
  );
  bridge.sqliteOrderLifecycle = 1;
  assert.deepEqual(
    await probeLifecycle("unused", "artifact", parse(document())),
    bridge.environment,
  );
  assert.equal(commands, 0);
  assert.equal(closed, 3);
});
