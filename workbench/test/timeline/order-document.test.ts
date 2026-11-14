import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { runDocument } from "../../src/timeline/run-document.js";
import {
  parseReplay,
  replayDocument,
} from "../../src/timeline/replay-document.js";
import { parseTrace } from "../../src/timeline/trace-contract.js";
import {
  recordBundle,
  replayBundle,
} from "../../src/timeline/artifact-bundle.js";
import { action } from "./document-fixture.js";
import {
  control,
  controlActor,
  controlAssertion,
  invalidWatermark,
  orderDocument,
  orderFiles,
  watermark,
} from "./order-document-fixture.js";

const jar = resolve(
  process.env.ZOOGLASS_SIMULATION_JAR ??
    "../zooglass/simulation-host/target/zooglass-simulation.jar",
);
const records = (trace: string) =>
  trace
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));

test("Order requests and acknowledgements cross delayed links, retain complete receipts, and strictly replay", async (t) => {
  const doc = orderDocument();
  doc.actions.push(
    action("repeat", 17, "progress-send", controlActor, { control }),
  );
  doc.assertions = [
    controlAssertion("before-request", 12, []),
    controlAssertion("before-ack", 15, []),
    controlAssertion("ack", 16, [watermark()]),
    controlAssertion("duplicate", 25, [watermark(), watermark(true)]),
  ];
  const input = await orderFiles(doc);
  t.after(input.close);
  const run = await runDocument(input.path, { jar });
  assert.equal(run.outcome, "passed", run.message);
  const trace = records(run.trace);
  assert.deepEqual(
    trace.filter((e) => e.kind === "control-receipt").map((e) => e.key[0]),
    [13, 20],
  );
  assert.deepEqual(
    trace
      .filter(
        (e) => e.kind === "delivered" && e.data.channel === "progress-receipt",
      )
      .map((e) => e.key[0]),
    [16, 23],
  );
  assert.equal(
    trace.filter((e) => e.kind === "state").length,
    2,
    "duplicate does not restage either view",
  );
  assert.ok(
    !trace.some(
      (e) => e.kind?.startsWith("retry-") || e.kind === "fault-decision",
    ),
  );
  const saved = join(input.directory, "run.json");
  await writeFile(saved, JSON.stringify(run));
  const replay = await replayDocument(saved, { jar, hostDelay: 1 });
  assert.equal(replay.status, "verified");
  assert.equal(replay.actual.trace, run.trace);

  for (const mutate of [
    (events: ReturnType<typeof records>) => {
      events.find((e) => e.kind === "control-receipt").parentId = events.find(
        (e) => e.kind === "action" && e.data.actionKind === "connect",
      ).eventId;
    },
    (events: ReturnType<typeof records>) => {
      events.find(
        (e) => e.kind === "delivered" && e.data.channel === "progress-request",
      ).data.envelope.throughSequence = 4;
    },
    (events: ReturnType<typeof records>) => {
      events.find((e) => e.kind === "control-receipt").connectionGeneration = 2;
    },
    (events: ReturnType<typeof records>) => {
      events[0].execution.profile = "receipt-age-restart-v1";
    },
    (events: ReturnType<typeof records>) => {
      const request = events.find(
        (e) => e.kind === "action" && e.data.actionKind === "progress-send",
      );
      request.key[2] = 0;
      request.data = {
        actionId: "wall",
        actionKind: "wall-clock-set",
        wallMillis: 1700000000010,
      };
    },
    (events: ReturnType<typeof records>) => {
      events.find((e) => e.kind === "assertion").data.actual = [watermark()];
    },
  ]) {
    const changed = records(run.trace);
    mutate(changed);
    assert.throws(() =>
      parseTrace(changed.map((e) => JSON.stringify(e)).join("\n") + "\n"),
    );
  }
  const changed = records(run.trace);
  const request = changed.find(
    (e) => e.kind === "action" && e.data.actionKind === "progress-send",
  );
  request.data.actionId = "undeclared";
  // Canonical saved evidence rejects even a structurally valid reassigned action before Java starts.
  const { encodeJson, parseJson } = await import("../../src/timeline/json.js");
  const changedTrace =
    changed.map((e) => encodeJson(parseJson(JSON.stringify(e)))).join("\n") +
    "\n";
  assert.throws(
    () => parseReplay(JSON.stringify({ ...run, trace: changedTrace })),
    /progress action differs/,
  );
  const alteredState = records(run.trace);
  const alteredIndex = alteredState.findIndex((e) => e.kind === "state");
  alteredState[alteredIndex].data.envelope.version = 99;
  const alteredTrace =
    alteredState
      .map((e) => encodeJson(parseJson(JSON.stringify(e))))
      .join("\n") + "\n";
  assert.doesNotThrow(() =>
    parseReplay(JSON.stringify({ ...run, trace: alteredTrace })),
  );
  const alteredPath = join(input.directory, "altered.json");
  await writeFile(alteredPath, JSON.stringify({ ...run, trace: alteredTrace }));
  const divergent = await replayDocument(alteredPath, {
    jar,
    diagnosticDirectory: input.directory,
  });
  assert.equal(divergent.status, "diverged");
  assert.equal(divergent.divergence?.record, alteredIndex);
});

test("disconnect before request arrival cancels commit; after commit cancels only the acknowledgement", async (t) => {
  for (const closeAt of [12, 13, 14, 16]) {
    const doc = orderDocument();
    doc.actions.push(action("close", closeAt, "disconnect", controlActor));
    if (closeAt >= 14)
      doc.actions.push(
        action("reconnect", closeAt + 1, "connect", controlActor),
        action("repeat", closeAt + 2, "progress-send", controlActor, {
          control,
        }),
      );
    else doc.untilMs = closeAt;
    doc.assertions = [
      controlAssertion(
        "received",
        doc.untilMs,
        closeAt >= 14 ? [watermark(true)] : [],
      ),
    ];
    const input = await orderFiles(doc);
    t.after(input.close);
    const run = await runDocument(input.path, { jar });
    assert.equal(run.outcome, "passed", run.message);
    const trace = records(run.trace);
    assert.equal(
      trace.filter((e) => e.kind === "state").length,
      closeAt <= 13 ? 0 : 2,
    );
    const dropped = trace.find((e) => e.kind === "dropped");
    assert.equal(
      dropped.data.channel,
      closeAt <= 13 ? "progress-request" : "progress-receipt",
    );
    assert.equal(dropped.key[0], closeAt);
    assert.equal(
      trace.find((e) => e.eventId === dropped.parentId).kind,
      "connection-closed",
    );
    assert.equal(trace.at(-1).pendingMessages, 0);
    if (closeAt >= 14)
      assert.equal(
        trace.find(
          (e) =>
            e.kind === "delivered" && e.data.channel === "progress-receipt",
        ).connectionGeneration,
        2,
      );
  }
});

test("zero-latency malformed and semantic controls retain complete literal acknowledgements", async (t) => {
  const doc = orderDocument(0);
  const rejected = (reason: string, overrides = {}) => ({
    ...watermark(),
    status: "rejected",
    reason,
    changedViews: [],
    ...overrides,
  });
  doc.actions.push(
    action("repeat", 11, "progress-send", controlActor, { control }),
    action("malformed", 12, "progress-send", controlActor, { control: {} }),
    action("backwards", 13, "progress-send", controlActor, {
      control: { ...control, throughSequence: 2 },
    }),
    action("unknown", 14, "progress-send", controlActor, {
      control: { ...control, sourceId: "unknown" },
    }),
  );
  doc.assertions = [
    controlAssertion("all", 25, [
      watermark(),
      watermark(true),
      invalidWatermark,
      rejected("backwardsWatermark", { throughSequence: 2 }),
      rejected("unknownSource", {
        stream: { ...watermark().stream, sourceId: "unknown" },
      }),
    ]),
  ];
  const input = await orderFiles(doc);
  t.after(input.close);
  const run = await runDocument(input.path, { jar });
  assert.equal(run.outcome, "passed", run.message);
  assert.ok(!records(run.trace).some((e) => e.kind === "link-send"));
});

test("reconnecting after request cancellation commits exactly once in the replacement session", async (t) => {
  const doc = orderDocument();
  doc.actions.push(
    action("close", 13, "disconnect", controlActor),
    action("reconnect", 14, "connect", controlActor),
    action("repeat", 15, "progress-send", controlActor, { control }),
  );
  const input = await orderFiles(doc);
  t.after(input.close);
  const run = await runDocument(input.path, { jar });
  assert.equal(run.outcome, "passed", run.message);
  const receipts = records(run.trace).filter(
    (e) => e.kind === "control-receipt",
  );
  assert.equal(receipts.length, 1);
  assert.deepEqual(receipts[0].data.envelope, watermark());
  assert.equal(receipts[0].connectionGeneration, 2);
  assert.equal(receipts[0].key[0], 18);
});

test("Order run bundles retain and replay control evidence without a database", async (t) => {
  const input = await orderFiles();
  t.after(input.close);
  const bundle = join(input.directory, "bundle");
  assert.equal(
    (await recordBundle(input.path, bundle, { jar })).outcome,
    "passed",
  );
  assert.equal((await replayBundle(bundle, { jar })).status, "verified");
});
