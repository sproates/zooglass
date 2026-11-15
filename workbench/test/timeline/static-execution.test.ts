import { eventData } from "../../src/timeline/event-schema.js";
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fixture, source, receipt, frame } from "./document-fixture.js";
import { parseTimelineDocument } from "../../src/timeline/contract.js";
import { runDocument } from "../../src/timeline/run-document.js";
import {
  parseReplay,
  replaySaved,
} from "../../src/timeline/replay-document.js";
import {
  recordBundle,
  readBundle,
  replayBundle,
} from "../../src/timeline/artifact-bundle.js";
import { inspectAdmission } from "../../src/timeline/admission.js";
import { parseJson } from "../../src/timeline/json.js";
import { acceptedReceipt } from "../../src/timeline/projected-assertions.js";
import { Bridge } from "../../src/timeline/bridge.js";
import {
  decodeHandshake,
  decodeResponse,
} from "../../src/timeline/host-protocol.js";

const jar = resolve(
  process.env.ZOOGLASS_SIMULATION_JAR ??
    "../zooglass/simulation-host/target/zooglass-simulation.jar",
);
function input() {
  const base = fixture();
  const field = {
    ...base.configuration.views[0].fields.reading,
    freshness: undefined,
  };
  const configuration = {
    ...base.configuration,
    views: [{ id: "stock-view", fields: { reading: field } }],
  };
  const document = {
    ...base.document,
    format: "timeline-simulation/v3",
    id: "static-unit",
    runtime: { ...base.document.runtime, profile: "memory-static-views-v1" },
    observationTargets: [{ viewId: "stock-view", entityId: "sku-4" }],
    actions: [
      { id: "open", atMs: 0, kind: "connect", actor: source },
      {
        id: "send-1",
        atMs: 10,
        kind: "source-send",
        actor: source,
        publication: "report-1",
      },
      {
        id: "send-2",
        atMs: 20,
        kind: "source-send",
        actor: source,
        publication: "report-2",
      },
    ],
    assertions: [
      {
        id: "accepted-1",
        atMs: 10,
        kind: "source-accepted",
        actor: source,
        send: "send-1",
      },
      {
        id: "data-1",
        atMs: 10,
        kind: "runtime-data",
        viewId: "stock-view",
        entityId: "sku-4",
        expected: { reading: { amount: 1 } },
      },
      {
        id: "accepted-2",
        atMs: 20,
        kind: "source-accepted",
        actor: source,
        send: "send-2",
      },
      {
        id: "data-2",
        atMs: 20,
        kind: "runtime-data",
        viewId: "stock-view",
        entityId: "sku-4",
        expected: { reading: { amount: 2 } },
      },
      {
        id: "full-receipts",
        atMs: 20,
        kind: "source-receipts",
        actor: source,
        expected: [receipt(1, 1), receipt(2, 2)],
      },
    ] as Record<string, unknown>[],
    untilMs: 20,
  };
  return { configuration, document };
}
async function saved(value = input()) {
  const directory = await mkdtemp(join(tmpdir(), "static-execution-"));
  const wire = JSON.stringify(value.configuration);
  value.document.runtime.sha256 = createHash("sha256")
    .update(wire)
    .digest("hex");
  await writeFile(join(directory, "runtime.json"), wire);
  const path = join(directory, "scenario.json");
  await writeFile(path, JSON.stringify(value.document));
  return {
    directory,
    path,
    close: () => rm(directory, { recursive: true, force: true }),
  };
}
const parse = (value: unknown) => parseTimelineDocument(JSON.stringify(value));

test("V3 closes unsupported combinations and old versions reject projected syntax", () => {
  const { document } = input();
  document.runtime.sha256 = "a".repeat(64);
  assert.equal(parse(document).profile, "memory-static-views-v1");
  const mutations = [
    { format: "timeline-simulation/v2" },
    { runtime: { ...document.runtime, profile: undefined } },
    { runtime: { ...document.runtime, storage: "sqlite" } },
    { links: [{ actor: source, latencyMs: 1 }] },
    { faults: [] },
    { retries: [] },
    { actions: [{ ...document.actions[1], kind: "source-retry" }] },
    {
      actions: [{ id: "stop", atMs: 0, kind: "service-stop", mode: "orderly" }],
    },
    {
      actions: [{ id: "stall", atMs: 0, kind: "writer-stall", actor: source }],
    },
    { actions: document.actions.slice(1) },
    {
      actions: [
        { ...document.actions[0], atMs: 1 },
        ...document.actions.slice(1),
      ],
    },
    {
      actions: [
        ...document.actions,
        { id: "close-source", actor: source, kind: "disconnect", atMs: 20 },
      ],
    },
    {
      actions: [...document.actions, { ...document.actions[0], id: "reopen" }],
    },
    { conversionReport: "../report.json" },
    { observationTargets: [] },
    { assertions: [{ ...document.assertions[0], atMs: 11 }] },
    { assertions: [{ ...document.assertions[0], actor: "missing" }] },
    {
      assertions: [
        document.assertions[0],
        { ...document.assertions[0], id: "reuse" },
      ],
    },
    { actions: [...document.actions, { ...document.actions[1], id: "extra" }] },
    { assertions: [{ ...document.assertions[1], expected: null }] },
  ];
  for (const change of mutations)
    assert.throws(() => parse({ ...document, ...change }), /invalid-scenario/);
});

test("receipt projection rejects missing, extra, rejected, wrong identity and reuse", () => {
  const identity = parseJson(
    '{"stream":{"sourceId":"feed","epoch":"v1","sourceEntityId":"one"},"publicationSequence":1}',
  );
  const envelope = parseJson(
    '{"status":"applied","stream":{"sourceId":"feed","epoch":"v1","sourceEntityId":"one"},"publicationSequence":1}',
  );
  const received = { eventId: "event-1", actor: "source", atMs: 10, envelope };
  assert.equal(acceptedReceipt([received], identity, new Set()), "event-1");
  assert.equal(acceptedReceipt([], identity, new Set()), undefined);
  assert.equal(
    acceptedReceipt(
      [received, { ...received, eventId: "event-2" }],
      identity,
      new Set(),
    ),
    undefined,
  );
  assert.equal(
    acceptedReceipt([received], identity, new Set(["event-1"])),
    undefined,
  );
  for (const status of ["failed", "rejected"])
    assert.equal(
      acceptedReceipt(
        [{ ...received, envelope: { ...(envelope as object), status } }],
        identity,
        new Set(),
      ),
      undefined,
    );
  assert.equal(
    acceptedReceipt(
      [received],
      parseJson(
        '{"stream":{"sourceId":"other","epoch":"v1","sourceEntityId":"one"},"publicationSequence":1}',
      ),
      new Set(),
    ),
    undefined,
  );
});

test("V3 runs public data checks and retains cumulative receipts, raw snapshots and strict replay", async () => {
  const files = await saved();
  try {
    assert.equal(
      (await inspectAdmission(files.path, jar)).execution,
      "eligible",
    );
    const run = await runDocument(files.path, { jar });
    assert.equal(run.outcome, "passed", run.message);
    assert.equal(run.format, "timeline-run/v3");
    const records = run.trace
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const observations = records.filter(
      (record) => record.kind === "runtime-data-observation",
    );
    assert.equal(observations.length, 2);
    assert.deepEqual(observations[0].data.snapshot.data, {
      reading: { publicationSequence: 1, payload: { amount: 1 } },
    });
    assert.deepEqual(observations[0].data.publicSnapshot.data, {
      reading: { amount: 1 },
    });
    const accepted = records.filter(
      (record) => record.data?.assertionKind === "source-accepted",
    );
    assert.notEqual(
      accepted[0].data.receiptEventId,
      accepted[1].data.receiptEventId,
    );
    assert.equal(
      (await replaySaved(parseReplay(JSON.stringify(run)), { jar })).status,
      "verified",
    );
    const bundle = join(files.directory, "bundle");
    assert.equal(
      (await recordBundle(files.path, bundle, { jar })).outcome,
      "passed",
    );
    assert.equal(
      (await readBundle(bundle)).versions.bundle,
      "timeline-bundle/v3",
    );
    assert.equal((await replayBundle(bundle, { jar })).status, "verified");
    for (const mutate of [
      (all: typeof records) => {
        all.find(
          (record) => record.kind === "runtime-data-observation",
        ).data.publicSnapshot.data = {};
      },
      (all: typeof records) => {
        all.find(
          (record) => record.data?.assertionKind === "source-accepted",
        ).data.receiptEventId = "event-0";
      },
      (all: typeof records) => {
        all.find(
          (record) => record.data?.assertionKind === "source-accepted",
        ).data.identity.stream.sourceId = "wrong";
      },
    ]) {
      const changed = structuredClone(records);
      mutate(changed);
      assert.throws(
        () =>
          parseReplay(
            JSON.stringify({
              ...run,
              trace:
                changed.map((record) => JSON.stringify(record)).join("\n") +
                "\n",
            }),
          ),
        /invalid/,
      );
    }
  } finally {
    await files.close();
  }
});

test("wrong, missing and extra public data fail without changing expectations", async () => {
  for (const expected of [
    { reading: { amount: 99 } },
    {},
    { reading: { amount: 1 }, extra: true },
  ]) {
    const value = input();
    value.document.assertions[1].expected = expected;
    const files = await saved(value);
    try {
      const run = await runDocument(files.path, { jar });
      assert.equal(run.outcome, "assertion-failed", run.message);
      assert.match(run.message!, /data-1/);
      assert.equal(
        parseReplay(JSON.stringify(run)).outcome,
        "assertion-failed",
      );
    } finally {
      await files.close();
    }
  }
});

test("public projection capability rejects old prepared hosts before initialization", async (context) => {
  const files = await saved();
  const open = Bridge.open;
  let initialized = 0;
  context.mock.method(
    Bridge,
    "open",
    async (...args: Parameters<typeof Bridge.open>) => {
      const opened = await open(...args);
      if (opened.bridge.protocol === 2) {
        opened.bridge.publicSnapshots = 0;
        const command = opened.bridge.command.bind(opened.bridge);
        opened.bridge.command = async (...values) => {
          initialized++;
          return command(...values);
        };
      }
      return opened;
    },
  );
  try {
    await assert.rejects(
      runDocument(files.path, { jar }),
      /static public snapshot support/,
    );
    assert.equal(initialized, 0);
  } finally {
    await files.close();
  }
});

test("projection metadata requires protocol2 installed support and paired snapshot counts", () => {
  const base = {
    protocol: 1,
    fixture: "timeline-proof-v1",
    artifact: "a".repeat(64),
    frameCap: 1024,
    storage: ["memory"],
    protectedAccess: false,
  };
  assert.throws(
    () => decodeHandshake({ ...base, publicSnapshots: 1 }),
    /publicSnapshots/,
  );
  const response = {
    turnId: 0,
    runtimeGeneration: 1,
    timeMs: 0,
    monotonicMs: 0,
    wallMillis: 0,
    effects: [],
    pendingTasks: 0,
    heldFrames: 0,
    snapshots: ["{}"],
    projectedSnapshots: [],
  };
  assert.throws(() => decodeResponse(response, 2), /projectedSnapshots count/);
});

test("initial public projection cannot disagree with internal snapshot metadata", () => {
  const publicValue: Record<string, unknown> = { ...frame() };
  delete publicValue.type;
  const raw = { ...publicValue };
  delete raw.publicationSequences;
  const initialization = {
    startTimeMs: 0,
    wallMillis: 1700000000000,
    monotonicMs: 0,
    snapshots: [raw],
    projectedSnapshots: [{ ...publicValue, version: 1 }],
  };
  assert.throws(
    () =>
      eventData(
        "runtime-initialized",
        parseJson(JSON.stringify(initialization)),
        "initialization",
        0,
        20,
        3,
      ),
    /projection changed snapshot metadata/,
  );
});
