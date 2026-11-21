import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fixture, source, receipt } from "./document-fixture.js";
import { parseTimelineDocument } from "../../src/timeline/contract.js";
import { runDocument } from "../../src/timeline/run-document.js";
import {
  parseReplay,
  replaySaved,
} from "../../src/timeline/replay-document.js";
import { inspectAdmission } from "../../src/timeline/admission.js";
const jar = resolve(
  process.env.ZOOGLASS_SIMULATION_JAR ??
    "../zooglass/simulation-host/target/zooglass-simulation.jar",
);
function recovery(storage: "memory" | "sqlite", mode: "orderly" | "abrupt") {
  const base = fixture();
  const configuration = {
    ...base.configuration,
    storage,
    views: [
      {
        id: "stock-view",
        fields: {
          reading: {
            sourceId: "warehouse-feed",
            type: "stock",
            mode: "arrival",
          },
        },
      },
    ],
  };
  const first = {
    ...receipt(1, 1),
    ...(storage === "sqlite" ? { status: "committed", reason: "sqlite" } : {}),
  };
  const second =
    storage === "memory"
      ? first
      : {
          ...first,
          status: "duplicate",
          reason: "alreadyCommitted",
          changedViews: [],
        };
  const data = (id: string, atMs: number, expected: unknown) => ({
    id,
    atMs,
    kind: "runtime-data",
    viewId: "stock-view",
    entityId: "sku-4",
    expected,
  });
  const document = {
    ...base.document,
    format: "timeline-simulation/v4",
    id: `recovery-${storage}-${mode}`,
    runtime: {
      ...base.document.runtime,
      storage,
      profile: "static-views-restart-v1",
      sha256: "a".repeat(64),
    },
    observationTargets: [{ viewId: "stock-view", entityId: "sku-4" }],
    actions: [
      { id: "open", atMs: 0, kind: "connect", actor: source },
      {
        id: "send",
        atMs: 10,
        kind: "source-send",
        actor: source,
        publication: "report-1",
      },
      { id: "stop", atMs: 15, kind: "service-stop", mode },
      { id: "start", atMs: 20, kind: "service-start" },
      { id: "reconnect", atMs: 21, kind: "connect", actor: source },
      {
        id: "retry",
        atMs: 25,
        kind: "source-retry",
        actor: source,
        publication: "report-1",
      },
    ] as Record<string, unknown>[],
    assertions: [
      data("before", 10, { reading: { amount: 1 } }),
      data(
        "recovered-before-input",
        20,
        storage === "memory" ? {} : { reading: { amount: 1 } },
      ),
      data("after", 25, { reading: { amount: 1 } }),
      {
        id: "receipts",
        atMs: 25,
        kind: "source-receipts",
        actor: source,
        expected: [first, second],
      },
    ] as Record<string, unknown>[],
    untilMs: 25,
  };
  return { configuration, document };
}
async function save(value: ReturnType<typeof recovery>) {
  const directory = await mkdtemp(join(tmpdir(), "static-recovery-"));
  const wire = JSON.stringify(value.configuration);
  value.document.runtime.sha256 = createHash("sha256")
    .update(wire)
    .digest("hex");
  await writeFile(join(directory, "runtime.json"), wire);
  const path = join(directory, "scenario.json");
  await writeFile(path, JSON.stringify(value.document));
  return { directory, path };
}
for (const storage of ["memory", "sqlite"] as const)
  for (const mode of ["orderly", "abrupt"] as const) {
    test(`V4 ${storage} ${mode} observes recovery before retry and replays`, async () => {
      const input = await save(recovery(storage, mode));
      try {
        assert.equal(
          (await inspectAdmission(input.path, jar)).execution,
          "eligible",
        );
        const result = await runDocument(input.path, { jar });
        assert.equal(
          result.outcome,
          "passed",
          result.message ?? result.trace.slice(-3000),
        );
        const saved = parseReplay(JSON.stringify(result));
        assert.equal((await replaySaved(saved, { jar })).status, "verified");
      } finally {
        await rm(input.directory, { recursive: true, force: true });
      }
    });
  }
test("V4 rejects unsupported and ambiguous input; V3 stays closed", () => {
  const { document } = recovery("memory", "orderly");
  const parse = (doc: unknown) => parseTimelineDocument(JSON.stringify(doc));
  parse(document);
  for (const change of [
    { format: "timeline-simulation/v3" },
    { conversionReport: "conversion.json" },
    { faults: [] },
    { retries: [] },
    { links: [{ actor: source, latencyMs: 1 }] },
    {
      actions: [
        ...document.actions,
        { id: "wall", atMs: 23, kind: "wall-clock-set", wallMillis: 100 },
      ],
    },
    {
      actions: document.actions.map((a) =>
        a.id === "retry" ? { ...a, atMs: 18 } : a,
      ),
    },
    { assertions: [{ ...document.assertions[0], atMs: 18 }] },
    {
      actions: [
        ...document.actions,
        {
          id: "extra",
          atMs: 10,
          kind: "source-retry",
          actor: source,
          publication: "report-1",
        },
      ],
      assertions: [
        {
          id: "accepted",
          atMs: 10,
          kind: "source-accepted",
          actor: source,
          send: "send",
        },
      ],
    },
  ])
    assert.throws(() => parse({ ...document, ...change }), /invalid-scenario/);
});

test("V4 respects declaration order for disconnect and stop at the same timestamp", () => {
  const { document } = recovery("memory", "orderly");
  document.actions.splice(2, 0, {
    id: "disconnect-before-stop",
    atMs: 15,
    kind: "disconnect",
    actor: source,
  });
  assert.doesNotThrow(() => parseTimelineDocument(JSON.stringify(document)));
});
for (const storage of ["memory", "sqlite"] as const)
  test(`V4 rejects ${storage} scenario with opposite configured storage before execution`, async () => {
    const value = recovery(storage, "orderly");
    value.configuration.storage = storage === "memory" ? "sqlite" : "memory";
    const input = await save(value);
    try {
      await assert.rejects(
        inspectAdmission(input.path, jar),
        /disagrees with scenario storage/,
      );
      await assert.rejects(
        runDocument(input.path, { jar }),
        /disagrees with scenario storage/,
      );
    } finally {
      await rm(input.directory, { recursive: true, force: true });
    }
  });

test("V4 trace contract rejects publication attempts without a runtime or connection", async () => {
  const { TraceProjections } =
    await import("../../src/timeline/trace-projections.js");
  const base = {
    kind: "action",
    id: "event-1",
    parent: null,
    causes: [],
    actor: source,
    timeMs: 20,
    key: [20, 0, 2, 0],
    runtimeGeneration: null,
    connectionGeneration: null,
    data: {
      actionId: "retry",
      actionKind: "source-retry",
      publication: "report-1",
    },
  };
  assert.throws(
    () => new TraceProjections(true).accept(base, "trace"),
    /running service/,
  );
  assert.throws(
    () =>
      new TraceProjections(true).accept(
        { ...base, runtimeGeneration: 2 },
        "trace",
      ),
    /active connection/,
  );
});

for (const name of ["m1", "m2", "s1", "s2", "s3", "b1"]) {
  test(`authored recovery witness ${name} records a complete V4 bundle and replays`, async () => {
    const { recordBundle, readBundle, replayBundle } =
      await import("../../src/timeline/artifact-bundle.js");
    const directory = await mkdtemp(join(tmpdir(), "recovery-bundle-"));
    const bundle = join(directory, "evidence");
    try {
      const run = await recordBundle(
        resolve(`scenarios/timeline-static-recovery/${name}/scenario.json`),
        bundle,
        { jar },
      );
      assert.equal(run.outcome, "passed", run.message);
      await readBundle(bundle);
      assert.equal((await replayBundle(bundle, { jar })).status, "verified");
      const saved = parseReplay(JSON.stringify(run));
      for (const format of ["timeline-run/v2", "timeline-run/v3"])
        assert.throws(
          () => parseReplay(JSON.stringify({ ...run, format })),
          /version mismatch/,
        );
      const lines = run.trace
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      const action = lines.find(
        (record) =>
          record.kind === "action" && record.data.actionKind === "source-send",
      );
      action.data.publication = "undeclared";
      const { encodeJson, parseJson } =
        await import("../../src/timeline/json.js");
      const trace = lines
        .map((line) => encodeJson(parseJson(JSON.stringify(line))) + "\n")
        .join("");
      assert.throws(
        () => parseReplay(JSON.stringify({ ...run, trace })),
        /differs from scenario|acceptance must reference/,
      );
      assert.equal(saved.scenario.profile, "static-views-restart-v1");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("V4 assertion failure remains valid evidence and replay reproduces it", async () => {
  const value = recovery("sqlite", "abrupt");
  value.document.assertions[1].expected = {};
  const input = await save(value);
  try {
    const run = await runDocument(input.path, { jar });
    assert.equal(run.outcome, "assertion-failed");
    const report = await replaySaved(parseReplay(JSON.stringify(run)), { jar });
    assert.equal(report.status, "verified");
    assert.equal(report.recordedOutcome, "assertion-failed");
  } finally {
    await rm(input.directory, { recursive: true, force: true });
  }
});
