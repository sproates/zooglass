import assert from "node:assert/strict";
import test from "node:test";
import { distribution, slope } from "../src/benchmark/metrics.js";
import {
  makeManifest,
  resolveRates,
  nextSlot,
} from "../src/benchmark/campaign/plan.js";
import type { JournalState } from "../src/benchmark/campaign/model.js";
import { cpuSeconds } from "../src/benchmark/resources.js";

test("latency percentiles preserve missing denominators and exact nearest ranks", () => {
  const result = distribution(
    Array.from({ length: 100 }, (_, i) => i + 1),
    120,
  );
  assert.deepEqual(
    [result.p50, result.p95, result.p99, result.max, result.missing],
    [50, 95, 99, 100, 20],
  );
  assert.equal(distribution([], 2).p99, null);
  assert.throws(() => distribution([NaN], 1));
  assert.throws(() => distribution([1, 2], 1));
  assert.equal(
    slope([
      { second: 1, value: 4 },
      { second: 2, value: 6 },
      { second: 3, value: 8 },
    ]),
    2,
  );
});

test("campaign order and comparison rate require all three passing replicates", () => {
  const manifest = makeManifest("fixture", { serviceJar: "fixture" });
  assert.equal(manifest.slots.length, 60);
  assert.deepEqual(
    manifest.slots.slice(0, 4).map((s) => [s.storage, s.replicate]),
    [
      ["memory", 1],
      ["sqlite", 1],
      ["memory", 2],
      ["sqlite", 2],
    ],
  );
  const state: JournalState = { attempts: [], charges: [], sessions: [] };
  for (const slot of manifest.slots.filter(
    (s) =>
      s.variant === "baseline" &&
      s.storage === "memory" &&
      [10, 30, 100].includes(s.baselineRate!),
  ))
    state.attempts.push({
      id: slot.id,
      slotId: slot.id,
      rate: slot.baselineRate!,
      sessionId: 1,
      status: "completed",
      completionHash: slot.id,
      completion: {
        inputHash: "fixture",
        id: slot.id,
        outcome: "pass",
        reason: "fixture",
        elapsedMs: 1,
        artifacts: [],
      },
    });
  assert.equal(resolveRates(manifest, state).rates.memory, 30);
  state.attempts.pop();
  assert.equal(resolveRates(manifest, state).rates.memory, 10);
  assert.equal(resolveRates(manifest, state).rates.sqlite, null);
  assert.equal(nextSlot(manifest, state, 0)?.slot?.storage, "sqlite");
});

test("process CPU parsing supports Linux and macOS elapsed formats", () => {
  assert.equal(cpuSeconds("00:03.25"), 3.25);
  assert.equal(cpuSeconds("01:02:03"), 3723);
  assert.equal(cpuSeconds("2-01:02:03"), 176523);
  assert.throws(() => cpuSeconds("broken"));
});

test("measurement receipts exclude warm-up and drain; fan-out remains independent", async () => {
  const { measure, classify } = await import("../src/benchmark/metrics.js");
  const { baseline } = await import("../src/benchmark/workload.js");
  const phase = {
    submitted: 0,
    acknowledged: 0,
    expectedUpdates: 0,
    validUpdates: 0,
    completedFanout: 0,
    missingReceipts: 0,
    missingUpdates: 0,
    pendingFanout: 0,
  };
  const raw = [
    {
      kind: "submit",
      phase: "warmup",
      entityId: "entity-0",
      sequence: 1,
      atMs: 99,
      plannedMs: 99,
    },
    {
      kind: "receipt",
      phase: "warmup",
      entityId: "entity-0",
      sequence: 1,
      atMs: 101,
    },
    {
      kind: "update",
      phase: "warmup",
      entityId: "entity-0",
      sequence: 1,
      atMs: 102,
      viewerId: "viewer-0",
      viewId: "view-0",
    },
    {
      kind: "submit",
      phase: "measurement",
      entityId: "entity-0",
      sequence: 2,
      atMs: 100,
      plannedMs: 100,
    },
    {
      kind: "update",
      phase: "measurement",
      entityId: "entity-0",
      sequence: 2,
      atMs: 110,
      viewerId: "viewer-0",
      viewId: "view-0",
    },
    {
      kind: "receipt",
      phase: "measurement",
      entityId: "entity-0",
      sequence: 2,
      atMs: 111,
    },
    {
      kind: "submit",
      phase: "measurement",
      entityId: "entity-0",
      sequence: 3,
      atMs: 1100,
      plannedMs: 1100,
    },
    {
      kind: "receipt",
      phase: "measurement",
      entityId: "entity-0",
      sequence: 3,
      atMs: 2100,
    },
  ] as import("../src/benchmark/model.js").Observation[];
  const report = {
    format: "benchmark-driver/v1",
    status: "completed",
    error: undefined,
    errorKind: undefined,
    cleanupError: undefined,
    options: {
      workload: { ...baseline, residentEntities: 1, hotEntities: 1 },
      rate: 1,
      warmupMs: 100,
      measurementMs: 2000,
      drainMs: 1000,
    },
    configuration:
      {} as import("../src/service/runtime-contract.js").RuntimeConfiguration,
    windows: [
      {
        phase: "warmup" as const,
        startMs: 0,
        endMs: 100,
        planned: 1,
        missed: 0,
        notOffered: 0,
      },
      {
        phase: "measurement" as const,
        startMs: 100,
        endMs: 2100,
        planned: 2,
        missed: 0,
        notOffered: 0,
      },
    ],
    wireBytes: {
      sentEnvelopes: 0,
      receivedReceipts: 0,
      receivedViewFrames: 0,
      envelopes: 0,
      receipts: 0,
      viewFrames: 0,
    },
    phaseTimes: {},
    maxBufferedBytes: 0,
    maxPending: 1,
    finalSnapshots: 1,
    capacityAssessment: "not-run",
    accounting: {
      phases: {
        seed: phase,
        warmup: {
          ...phase,
          submitted: 1,
          acknowledged: 1,
          expectedUpdates: 1,
          validUpdates: 1,
          completedFanout: 1,
        },
        measurement: {
          ...phase,
          submitted: 2,
          acknowledged: 2,
          expectedUpdates: 2,
          validUpdates: 1,
          completedFanout: 1,
          missingUpdates: 1,
          pendingFanout: 1,
        },
      },
      pending: 1,
      faults: {},
      rawEntries: raw.length,
      encodedBytes: 0,
      allocatedBytes: 0,
    },
  };
  const m = await measure(report, raw);
  assert.equal(m.inWindowReceipts, 1);
  assert.equal(m.drainReceipts, 1);
  assert.equal(m.achievedPerSecond, 0.5);
  assert.equal(m.latency.fanoutFromPlan.missing, 1);
  assert.equal(m.latency.receiptFromPlan.p99, 1000);
  assert.equal(m.buckets[1].fanoutBacklog, 1);
  assert.equal(classify(report, m).outcome, "service-budget");
  await assert.rejects(measure(report, raw.slice(0, -1)), /accounting/);
  const late = raw.map((row) =>
    row.sequence === 3
      ? { ...row, atMs: row.kind === "submit" ? 2101 : 2102 }
      : row,
  );
  const lateMetrics = await measure(report, late);
  assert.equal(classify(report, lateMetrics).outcome, "harness-limited");
  assert.equal(lateMetrics.submitted, 2);
  const passing = structuredClone(m);
  passing.lateSubmissions = 0;
  passing.achievedPerSecond = 1;
  passing.receiptBacklogSlope = 0.01;
  passing.fanoutBacklogSlope = 0.01;
  passing.buckets = Array.from({ length: 60 }, (_, i) => ({
    ...m.buckets[0],
    second: i + 1,
  }));
  passing.latency.receiptFromPlan = distribution(Array(1000).fill(100), 1000);
  passing.latency.fanoutFromPlan = distribution(Array(1000).fill(250), 1000);
  const valid = structuredClone(report);
  valid.accounting.phases.measurement.missingUpdates = 0;
  assert.equal(classify(valid, passing).outcome, "pass");
  assert.equal(
    classify(valid, { ...passing, fanoutBacklogSlope: 0.010001 }).outcome,
    "service-budget",
  );
  assert.equal(
    classify(valid, { ...passing, achievedPerSecond: 0.989 }).outcome,
    "service-budget",
  );
  passing.latency.receiptFromPlan.p99 = 100.001;
  assert.equal(classify(valid, passing).outcome, "service-budget");
  valid.accounting.faults = { "wrong-payload": 1 };
  assert.equal(classify(valid, passing, false).outcome, "correctness");
});
