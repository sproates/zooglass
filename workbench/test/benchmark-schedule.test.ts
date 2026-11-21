import assert from "node:assert/strict";
import test from "node:test";
import {
  Schedule,
  driveWindows,
  scheduleWindows,
} from "../src/benchmark/schedule.js";
import { Workload, baseline } from "../src/benchmark/workload.js";

test("schedule skips elapsed slots, including sub-10ms stalls, without catch-up", () => {
  const schedule = new Schedule(1000, 20);
  assert.deepEqual(schedule.wake(0), { slot: 0, plannedMs: 0, missed: 0 });
  assert.deepEqual(schedule.wake(6), { slot: 6, plannedMs: 6, missed: 5 });
  assert.deepEqual(schedule.wake(6), { missed: 0 });
  assert.deepEqual(schedule.wake(30), { missed: 13 });
  assert.equal(schedule.remaining, 0);
});
test("slow rate records an expired slot and preserves future denominators", () => {
  const schedule = new Schedule(10, 1000);
  assert.deepEqual(schedule.wake(11), { missed: 1 });
  assert.equal(schedule.remaining, 9);
  assert.deepEqual(schedule.wake(99), { missed: 0 });
  assert.deepEqual(schedule.wake(100), { slot: 1, plannedMs: 100, missed: 0 });
});
test("workload keeps independent streams and exact encoded payload sizes", () => {
  for (const payloadBytes of [256, 4096]) {
    const workload = new Workload({ ...baseline, payloadBytes });
    assert.equal(workload.publication(0).publicationSequence, 1);
    assert.equal(workload.publication(1).publicationSequence, 1);
    const value = workload.publication(0);
    assert.equal(value.publicationSequence, 2);
    assert.equal(value.payload.marker, "0:2");
    assert.equal(
      Buffer.byteLength(JSON.stringify(value.payload)),
      payloadBytes,
    );
    assert.equal(workload.configuration.maxStreams, 10000);
  }
});

test("each fractional slot fires at its own published due time", () => {
  for (const rate of [30, 300]) {
    const schedule = new Schedule(rate, 2000);
    for (let slot = 0; slot < schedule.total; slot++) {
      const plannedMs = schedule.nextMs;
      assert.deepEqual(schedule.wake(plannedMs), {
        slot,
        plannedMs,
        missed: 0,
      });
    }
  }
});

test("a stall spanning warm-up end consumes elapsed measurement slots", async () => {
  const warmup = new Schedule(1000, 4);
  const measurement = new Schedule(1000, 8);
  const windows = scheduleWindows(warmup, measurement);
  const offers: string[] = [];
  let now = 20;
  await driveWindows(
    [warmup, measurement],
    windows,
    now,
    {
      now: () => now,
      sleep: async (ms) => {
        now += now === 20 ? 7 : ms;
      },
    },
    () => {},
    (phase, slot) => {
      offers.push(`${phase}:${slot}`);
    },
  );
  assert.deepEqual(offers, [
    "warmup:0",
    "measurement:3",
    "measurement:4",
    "measurement:5",
    "measurement:6",
    "measurement:7",
  ]);
  assert.deepEqual(
    windows.map((w) => [w.startMs, w.endMs, w.missed, w.notOffered]),
    [
      [20, 24, 3, 3],
      [24, 32, 3, 3],
    ],
  );
});

test("slow synchronous offers yield to pending socket callbacks", async () => {
  const schedules = [new Schedule(1000, 4), new Schedule(1000, 4)] as const;
  const windows = scheduleWindows(...schedules);
  let now = 0;
  let yields = 0;
  await driveWindows(
    schedules,
    windows,
    now,
    {
      now: () => now,
      sleep: async (ms) => {
        if (ms === 0) yields++;
        now += ms;
      },
    },
    () => {},
    () => {
      now += 2;
    },
  );
  assert.ok(yields >= 2);
});

test("an early stop retains the full planned workload and its windows", async () => {
  const schedules = [new Schedule(100, 20), new Schedule(100, 30)] as const;
  const windows = scheduleWindows(...schedules);
  let now = 10;
  await assert.rejects(
    driveWindows(
      schedules,
      windows,
      now,
      {
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      },
      () => {},
      (_phase, slot) => {
        if (slot === 1) throw new Error("sender limit");
      },
    ),
    /sender limit/,
  );
  assert.deepEqual(
    windows.map((w) => [w.planned, w.notOffered, w.startMs, w.endMs]),
    [
      [2, 1, 10, 30],
      [3, 3, 30, 60],
    ],
  );
});
