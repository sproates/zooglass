import assert from "node:assert/strict";
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
  stat,
} from "node:fs/promises";
import { readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { Bridge } from "../../src/timeline/bridge.js";
import { inspectAdmission } from "../../src/timeline/admission.js";
import { runDocument } from "../../src/timeline/run-document.js";
import {
  replayDocument,
  parseReplay,
} from "../../src/timeline/replay-document.js";
import {
  recordBundle,
  replayBundle,
} from "../../src/timeline/artifact-bundle.js";
import { canonicalJson, parseJson } from "../../src/timeline/json.js";
import {
  durableReceipt,
  installed,
  sqliteFiles,
  sqliteInput,
} from "./sqlite-document-fixture.js";

const jar = resolve(
  process.env.ZOOGLASS_SIMULATION_JAR ??
    "../zooglass/simulation-host/target/zooglass-simulation.jar",
);
for (const mode of ["orderly", "abrupt"]) {
  for (const restart of [25, 40, 50]) {
    test(`SQLite document ${mode} recovery at ${restart} preserves state, age and durable duplicate identity`, async () => {
      const input = await sqliteFiles(sqliteInput(restart, mode));
      const parent = await mkdtemp(join(tmpdir(), "sqlite-success-"));
      try {
        const result = await runDocument(input.path, {
          jar,
          diagnosticDirectory: parent,
          hostDelay: restart === 50 ? 70 : 0,
          jvmPauseMs: restart === 50 ? 90 : 0,
        });
        assert.equal(
          result.outcome,
          "passed",
          result.message ?? "unexpected outcome",
        );
        parseReplay(JSON.stringify(result));
        assert.match(result.environment.java.sqliteVersion, /^\d+\.\d+\.\d+/);
        const records = result.trace
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        const initialized = records.filter(
          (record) => record.kind === "runtime-initialized",
        );
        assert.equal(initialized.length, 2);
        assert.deepEqual(initialized[1].data.snapshots, [
          installed(restart >= 40 ? 2 : 1, restart >= 40 ? "stale" : "fresh"),
        ]);
        assert.equal(initialized[1].data.monotonicMs, 0);
        assert.equal(initialized[1].data.startTimeMs, restart);
        assert.deepEqual(
          await readdir(parent),
          [],
          "successful database is closed and removed",
        );
        assert.ok(
          !result.trace.includes(parent),
          "machine paths never enter semantic trace",
        );
      } finally {
        await input.close();
        await rm(parent, { recursive: true, force: true });
      }
    });
  }
}

test("SQLite failed assertions retain database diagnostics while replay re-executes from empty storage", async () => {
  const setup = sqliteInput();
  const assertions = setup.document.assertions as Record<string, unknown>[];
  assertions.find((entry) => entry.id === "recovered")!.expected = {
    outcome: "available",
    snapshot: installed(1, "fresh"),
  };
  const input = await sqliteFiles(setup);
  const parent = await mkdtemp(join(tmpdir(), "sqlite-failed-"));
  try {
    const result = await runDocument(input.path, {
      jar,
      diagnosticDirectory: parent,
    });
    assert.equal(
      result.outcome,
      "assertion-failed",
      result.message ?? "unexpected outcome",
    );
    const database = result.diagnostics.retainedStore?.database;
    assert.ok(database);
    assert.ok((await stat(database)).size > 0);
    const saved = join(parent, "run.json");
    await writeFile(saved, JSON.stringify(result));
    await writeFile(database, "original final database deliberately corrupted");
    await input.close();
    const replay = await replayDocument(saved, { jar });
    assert.equal(replay.status, "verified");
    assert.equal(replay.recordedOutcome, "assertion-failed");
    if (replay.actual?.diagnostics.retainedStore?.database)
      await rm(
        resolve(replay.actual.diagnostics.retainedStore!.database!, ".."),
        {
          recursive: true,
          force: true,
        },
      );
  } finally {
    await input.close();
    await rm(parent, { recursive: true, force: true });
  }
});

test("SQLite portable bundle contains semantic evidence and replays after inputs disappear", async () => {
  const input = await sqliteFiles();
  const parent = await mkdtemp(join(tmpdir(), "sqlite-bundle-"));
  const directory = join(parent, "bundle");
  try {
    const result = await recordBundle(input.path, directory, { jar });
    assert.equal(
      result.outcome,
      "passed",
      result.message ?? "unexpected outcome",
    );
    const manifest = JSON.parse(
      await readFile(join(directory, "manifest.json"), "utf8"),
    );
    assert.equal(manifest.initialState.storage, "sqlite");
    assert.ok(
      !(await readdir(directory)).some((name) => /\.db|wal|shm/.test(name)),
    );
    await input.close();
    assert.equal((await replayBundle(directory, { jar })).status, "verified");
    parseReplay(JSON.stringify(result));
    assert.ok(parseJson(result.scenario));
  } finally {
    await input.close();
    await rm(parent, { recursive: true, force: true });
  }
});

test("SQLite replay rejects altered recovery targets and authored assertions before execution", async () => {
  const input = await sqliteFiles();
  try {
    const result = await runDocument(input.path, { jar });
    assert.equal(
      result.outcome,
      "passed",
      result.message ?? "unexpected outcome",
    );
    for (const mutate of [
      (records: { kind: string; data: Record<string, unknown> }[]) => {
        records.find((r) => r.kind === "runtime-initialized")!.data.snapshots =
          [];
      },
      (records: { kind: string; data: Record<string, unknown> }[]) => {
        records.find((r) => r.kind === "runtime-observation")!.data.entityId =
          "not-declared";
      },
      (records: { kind: string; data: Record<string, unknown> }[]) => {
        records.find(
          (r) =>
            r.kind === "assertion" &&
            r.data.assertionKind === "runtime-snapshot",
        )!.data.assertionId = "forged";
      },
    ]) {
      const records = result.trace
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      mutate(records);
      const forged = {
        ...result,
        trace:
          records
            .map((record) => canonicalJson(JSON.stringify(record)))
            .join("\n") + "\n",
      };
      assert.throws(
        () => parseReplay(JSON.stringify(forged)),
        /invalid|target|assertion|snapshot/i,
      );
    }
  } finally {
    await input.close();
  }
});

test("invalid SQLite targets reject before allocating writable state", async () => {
  const setup = sqliteInput();
  setup.document.observationTargets = [
    { viewId: "not-configured", entityId: "sku-4" },
  ];
  setup.document.assertions = [];
  const input = await sqliteFiles(setup);
  const parent = await mkdtemp(join(tmpdir(), "sqlite-not-admitted-"));
  try {
    await assert.rejects(
      runDocument(input.path, { jar, diagnosticDirectory: parent }),
      /target|view/i,
    );
    assert.deepEqual(await readdir(parent), []);
  } finally {
    await input.close();
    await rm(parent, { recursive: true, force: true });
  }
});

test("a failed SQLite restart retains partial evidence and the diagnostic store", async () => {
  const input = await sqliteFiles(sqliteInput(50, "orderly"));
  const parent = await mkdtemp(join(tmpdir(), "sqlite-start-failure-"));
  const streamed: string[] = [];
  try {
    const result = await runDocument(input.path, {
      jar,
      diagnosticDirectory: parent,
      observeRecord: (line) => {
        streamed.push(line);
        const record = JSON.parse(line);
        if (
          record.kind === "action" &&
          record.data.actionKind === "service-start"
        ) {
          const directory = readdirSync(parent)[0];
          writeFileSync(
            join(parent, directory, "runtime.db"),
            "invalid SQLite database",
          );
        }
      },
    });
    assert.equal(
      result.outcome,
      "infrastructure-failed",
      result.message ?? "unexpected outcome",
    );
    assert.ok(result.diagnostics.retainedStore);
    assert.ok(!streamed.some((line) => JSON.parse(line).kind === "result"));
    assert.equal(result.trace, streamed.join(""));
    assert.throws(
      () => parseReplay(JSON.stringify(result)),
      /incomplete|outcome|infrastructure/i,
    );
  } finally {
    await input.close();
    await rm(parent, { recursive: true, force: true });
  }
});

test("recovery initialization precedes a new contribution at the same timestamp", async () => {
  const setup = sqliteInput();
  const actions = setup.document.actions as Record<string, unknown>[];
  actions.push({
    id: "new-contribution",
    atMs: 50,
    kind: "source-send",
    actor: "viewer-logical-source",
    publication: "report-2",
  });
  const expected = installed(3, "fresh");
  expected.data = {
    reading: { publicationSequence: 2, payload: { amount: 2 } },
  };
  expected.status.fields.reading.receivedAtMillis = 1700000000050;
  setup.document.assertions = [
    {
      id: "new-fresh",
      atMs: 50,
      kind: "runtime-snapshot",
      viewId: "stock-view",
      entityId: "sku-4",
      expected: { outcome: "available", snapshot: expected },
    },
  ];
  setup.document.end = {
    pendingFutureTasks: "allow",
    pendingMessages: 0,
    heldFrames: 0,
  };
  const input = await sqliteFiles(setup);
  try {
    const result = await runDocument(input.path, { jar });
    assert.equal(
      result.outcome,
      "passed",
      result.message ?? "unexpected outcome",
    );
    const initialized = result.trace
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((record) => record.kind === "runtime-initialized");
    assert.deepEqual(initialized[1].data.snapshots, [installed(2, "stale")]);
  } finally {
    await input.close();
  }
});

test("a host without installed-observation capability rejects before database allocation", async () => {
  const input = await sqliteFiles();
  const parent = await mkdtemp(join(tmpdir(), "sqlite-old-host-"));
  const open = Bridge.open;
  Bridge.open = async (...args) => {
    const result = await open(...args);
    result.bridge.installedObservations = 0;
    return result;
  };
  try {
    const report = await inspectAdmission(input.path, jar);
    assert.equal(report.execution, "unsupported");
    await assert.rejects(
      runDocument(input.path, { jar, diagnosticDirectory: parent }),
      /observation/i,
    );
    assert.deepEqual(await readdir(parent), []);
  } finally {
    Bridge.open = open;
    await input.close();
    await rm(parent, { recursive: true, force: true });
  }
});

test("lost durable receipt survives downtime and retries as the original committed identity", async () => {
  const setup = sqliteInput();
  setup.document.id = "memory-restart"; // Retain independently qualified loss-draw inputs.
  setup.document.actions = (
    setup.document.actions as Record<string, unknown>[]
  ).filter((a) => a.id !== "reconnect" && a.id !== "retry");
  setup.document.faults = [
    {
      id: "drop-receipt",
      kind: "receipt-loss",
      action: "send",
      probability: { numerator: 1, denominator: 2 },
    },
  ];
  setup.document.retries = [
    {
      action: "send",
      maxAttempts: 3,
      receiptTimeoutMs: 10,
      retryIntervalMs: 0,
      unavailableRetryIntervalMs: 30,
    },
  ];
  const assertions = setup.document.assertions as Record<string, unknown>[];
  assertions.find((a) => a.id === "original-receipt")!.expected = [
    durableReceipt(true),
  ];
  assertions.push({
    id: "extra-downtime",
    atMs: 25,
    kind: "runtime-snapshot",
    viewId: "stock-view",
    entityId: "sku-4",
    expected: { outcome: "runtime-unavailable" },
  });
  const input = await sqliteFiles(setup);
  try {
    const result = await runDocument(input.path, { jar });
    assert.equal(
      result.outcome,
      "passed",
      result.message ?? "unexpected outcome",
    );
    const records = result.trace
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const unavailable = records.filter((r) => r.kind === "attempt-outcome");
    assert.equal(unavailable.length, 1);
    assert.equal(unavailable[0].key[0], 20);
    assert.equal(unavailable[0].data.attempt, 2);
    const draws = records.filter((r) => r.kind === "fault-decision");
    assert.deepEqual(
      draws.map((r) => r.key[0]),
      [10, 50],
    );
  } finally {
    await input.close();
  }
});
