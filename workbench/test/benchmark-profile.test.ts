import { epochOffset, measurementStart } from "../src/benchmark/profile/arm.js";
import assert from "node:assert/strict";
import test from "node:test";
import type { Observation } from "../src/benchmark/model.js";
import { intervalActivity } from "../src/benchmark/profile/interval.js";
import { profileProtocol } from "../src/benchmark/profile/runner.js";

test("profiling protocol keeps a finite paired diagnostic distinct from smoke", () => {
  assert.deepEqual(profileProtocol(false), {
    rate: 300,
    settleMs: 60000,
    warmupMs: 30000,
    measurementMs: 60000,
    drainMs: 10000,
    innerStartMs: 20000,
    innerEndMs: 50000,
  });
  const smoke = profileProtocol(true);
  assert.equal(smoke.rate, 100);
  assert.ok(smoke.measurementMs >= smoke.innerEndMs);
});

test("a planned measurement timestamp cannot hide a warm-up or correctness failure", () => {
  const report = {
    errorKind: undefined,
    error: undefined,
    cleanupError: undefined,
    accounting: { faults: {} },
    windows: [
      {
        phase: "measurement" as const,
        startMs: 1000,
        endMs: 3000,
        planned: 200,
        missed: 0,
        notOffered: 200,
      },
    ],
  };
  assert.throws(
    () => measurementStart(report, false),
    /did not reach measurement/,
  );
  assert.throws(
    () =>
      measurementStart(
        { ...report, errorKind: "correctness", error: "invalid subscription" },
        true,
      ),
    /invalid subscription/,
  );
  assert.equal(
    measurementStart(
      { ...report, errorKind: "service-budget", error: "drain deadline" },
      true,
    ),
    1000,
  );
});

test("matched intervals include carryover and count events at the start but exclude the end", async () => {
  async function* observations(): AsyncGenerator<Observation> {
    yield { kind: "submit", phase: "seed", atMs: 1 };
    yield { kind: "receipt", phase: "seed", atMs: 2 };
    yield { kind: "submit", phase: "warmup", atMs: 9 };
    yield { kind: "update", phase: "warmup", atMs: 9.5 };
    yield { kind: "receipt", phase: "warmup", atMs: 10 };
    yield { kind: "submit", phase: "measurement", atMs: 11 };
    yield { kind: "receipt", phase: "measurement", atMs: 12 };
    yield { kind: "submit", phase: "measurement", atMs: 19 };
    yield { kind: "update", phase: "measurement", atMs: 20 };
  }
  assert.deepEqual(await intervalActivity(observations(), 10, 20), {
    startMs: 10,
    endMs: 20,
    submitted: 2,
    receipts: 2,
    updates: 0,
    receiptBacklogStart: 1,
    receiptBacklogEnd: 1,
    fanoutBacklogStart: 0,
    fanoutBacklogEnd: 2,
  });
});

test("clock mapping tolerates submillisecond sampling but rejects changed or missing clocks", () => {
  const anchors = [0, 1000, 2000].map((monotonicMs) => ({
    monotonicMs,
    wallMs: monotonicMs + 1700000000000,
    uncertaintyMs: 1,
  }));
  assert.equal(epochOffset(anchors), 1700000000000);
  assert.throws(() => epochOffset(anchors.slice(0, 2)), /clock anchors/);
  assert.throws(
    () =>
      epochOffset([
        ...anchors.slice(0, 2),
        {
          ...anchors[2],
          wallMs: anchors[2].wallMs + 50,
        },
      ]),
    /Wall clock changed/,
  );
  for (const uncertaintyMs of [NaN, Infinity, -1, 6])
    assert.throws(
      () => epochOffset(anchors.map((a) => ({ ...a, uncertaintyMs }))),
      /clock anchors/,
    );
});
