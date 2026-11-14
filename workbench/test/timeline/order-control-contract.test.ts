import assert from "node:assert/strict";
import test from "node:test";
import { Bridge } from "../../src/timeline/bridge.js";
import {
  probeLifecycle,
  requiredConfigurationProfile,
} from "../../src/timeline/admission.js";
import { parseTimelineDocument } from "../../src/timeline/contract.js";
import { parseJson } from "../../src/timeline/json.js";
import { watermarkEnvelope } from "../../src/timeline/progress-contract.js";
import { executionSettings } from "../../src/timeline/document-profile.js";
import { action } from "./document-fixture.js";
import {
  controlActor,
  invalidWatermark,
  orderDocument,
  watermark,
} from "./order-document-fixture.js";

const parse = (value: unknown) => parseTimelineDocument(JSON.stringify(value));
function input() {
  const doc = orderDocument();
  doc.runtime.sha256 = "a".repeat(64);
  return doc;
}
test("Order controls require explicit v2 SQLite profile and progress actor; lifecycle and automatic control faults are denied", () => {
  const doc = input();
  assert.equal(requiredConfigurationProfile(parse(doc)), "sqlite-order-v1");
  for (const change of [
    { format: "timeline-simulation/v1" },
    { runtime: { ...doc.runtime, storage: "memory" } },
    { runtime: { ...doc.runtime, profile: "receipt-age-restart-v1" } },
    { actors: [{ id: controlActor, role: "source" }] },
    { actors: [{ id: controlActor, role: "client" }] },
    {
      actions: [
        ...doc.actions,
        action("publish", 12, "source-send", controlActor, {
          publication: "missing",
        }),
      ],
    },
    { assertions: [{ ...doc.assertions[0], kind: "source-receipts" }] },
    {
      retries: [
        {
          action: "watermark",
          maxAttempts: 2,
          receiptTimeoutMs: 5,
          retryIntervalMs: 0,
          unavailableRetryIntervalMs: 5,
        },
      ],
    },
    {
      faults: [
        {
          id: "loss",
          kind: "receipt-loss",
          action: "watermark",
          probability: { numerator: 1, denominator: 1 },
        },
      ],
    },
  ])
    assert.throws(() => parse({ ...doc, ...change }));
  const { profile, ...runtime } = doc.runtime;
  void profile;
  assert.throws(() => parse({ ...doc, runtime }));
  for (const control of [
    { kind: "service-stop", mode: "orderly" },
    { kind: "service-start" },
    { kind: "wall-clock-set", wallMillis: 1000000 },
  ])
    assert.throws(
      () =>
        parse({ ...doc, actions: [{ id: "runtime", atMs: 0, ...control }] }),
      /does not support runtime lifecycle/,
    );
  assert.throws(
    () => parse({ ...doc, actions: [doc.actions[1]] }),
    /requires a connected actor/,
  );
  assert.doesNotThrow(() =>
    parse({
      ...doc,
      actions: [
        doc.actions[0],
        action("malformed", 10, "progress-send", controlActor, {
          control: { nonsense: "owned by runtime" },
        }),
      ],
    }),
  );
  const oversized = parse({
    ...doc,
    actions: [
      doc.actions[0],
      action("large", 10, "progress-send", controlActor, {
        control: { value: "x".repeat(4100) },
      }),
    ],
  });
  assert.throws(
    () => executionSettings(oversized, "{}"),
    /progress control exceeds 4096/,
  );
});

test("complete watermark schema rejects omitted, invalid, publication-shaped and processing-failure acknowledgements", () => {
  const validate = (value: unknown) =>
    watermarkEnvelope(parseJson(JSON.stringify(value)), "ack");
  assert.doesNotThrow(() => validate(watermark()));
  assert.doesNotThrow(() => validate(invalidWatermark));
  assert.doesNotThrow(() =>
    validate({
      ...watermark(),
      status: "rejected",
      reason: "unknownSource",
      version: 0,
      changedViews: [],
    }),
  );
  assert.doesNotThrow(() =>
    watermarkEnvelope(
      parseJson(
        JSON.stringify(watermark()).replace(
          '"version":1',
          '"version":9223372036854775807',
        ),
      ),
      "ack",
    ),
  );
  for (const value of [
    { ...watermark(), throughSequence: 0 },
    { ...watermark(), throughSequence: Number.MAX_SAFE_INTEGER + 1 },
    { ...watermark(), version: 0 },
    { ...watermark(), stream: null },
    { ...watermark(), reason: "invented" },
    { ...watermark(), changedViews: ["order-summary", "order-summary"] },
    { ...watermark(), publicationSequence: 3 },
    { ...watermark(true), changedViews: ["order-summary"] },
    { ...invalidWatermark, version: 0 },
    {
      ...watermark(),
      status: "failed",
      reason: "processingFailure",
      version: null,
      changedViews: [],
    },
  ])
    assert.throws(() => validate(value));
  for (const key of Object.keys(watermark())) {
    const value: Record<string, unknown> = watermark();
    delete value[key];
    assert.throws(() => validate(value));
  }
});

test("Order capability is negotiated independently before runtime commands", async (t) => {
  let commands = 0,
    closes = 0;
  const bridge = {
    memoryLifecycle: 1,
    sqliteLifecycle: 1,
    sqliteOrder: 0,
    command: () => {
      commands++;
    },
    close: async () => {
      closes++;
    },
    environment: { javaRuntime: "25", sqliteVersion: "3" },
  };
  t.mock.method(Bridge, "open", async () => ({ artifact: "artifact", bridge }));
  await assert.rejects(
    probeLifecycle("unused.jar", "artifact", parse(input())),
    /does not support SQLite Order/,
  );
  bridge.sqliteOrder = 1;
  assert.deepEqual(
    await probeLifecycle("unused.jar", "artifact", parse(input())),
    bridge.environment,
  );
  assert.equal(commands, 0);
  assert.equal(closes, 2);
});
