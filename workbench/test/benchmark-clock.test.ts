import assert from "node:assert/strict";
import test from "node:test";
import { benchmarkClock, type ClockHost } from "../src/benchmark/clock.js";
import {
  Schedule,
  driveWindows,
  scheduleWindows,
} from "../src/benchmark/schedule.js";

function hostClock() {
  let now = 0;
  const delays: number[] = [];
  let yields = 0;
  const host: ClockHost = {
    now: () => now,
    async delay(ms, signal) {
      signal?.throwIfAborted();
      delays.push(ms);
      // Model integer timer resolution and dispatch overhead deterministically.
      now += Math.max(1, Math.floor(ms)) + 0.2;
    },
    async yield(signal) {
      signal?.throwIfAborted();
      yields++;
      now += 0.05;
    },
  };
  return {
    host,
    delays,
    yields: () => yields,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test("millisecond slots survive timer clamping without early offers or catch-up", async () => {
  const fake = hostClock();
  const clock = benchmarkClock(undefined, fake.host);
  const schedules = [new Schedule(1000, 10), new Schedule(1000, 10)] as const;
  const windows = scheduleWindows(...schedules);
  const offers: number[] = [];
  await driveWindows(
    schedules,
    windows,
    0,
    clock,
    () => {},
    (_phase, _slot, planned) => {
      assert.ok(clock.now() >= planned);
      assert.ok(clock.now() < planned + 1);
      offers.push(planned);
      fake.advance(0.1);
    },
  );
  assert.deepEqual(
    offers,
    Array.from({ length: 20 }, (_, i) => i),
  );
  assert.deepEqual(
    windows.map((w) => w.missed),
    [0, 0],
  );
  assert.ok(clock.now() >= 20);
  assert.equal(fake.delays.length, 0);
  assert.ok(fake.yields() > 0);
});

test("long waits use timers then yield until the deadline", async () => {
  const fake = hostClock();
  await benchmarkClock(undefined, fake.host).sleep(10.5);
  assert.ok(fake.host.now() >= 10.5);
  assert.ok(fake.host.now() < 10.6);
  assert.deepEqual(fake.delays, [9]);
  assert.ok(fake.yields() > 0);
});

test("overdue work yields once and cancellation interrupts fine waiting", async () => {
  const fake = hostClock();
  await benchmarkClock(undefined, fake.host).sleep(-1);
  assert.equal(fake.yields(), 1);
  const controller = new AbortController();
  const reason = new Error("stop pacing");
  fake.host.yield = async () => {
    controller.abort(reason);
  };
  await assert.rejects(
    benchmarkClock(controller.signal, fake.host).sleep(0.5),
    reason,
  );
});

test("coarse oversleep skips elapsed slots across the fixed phase boundary", async () => {
  const fake = hostClock();
  fake.host.delay = async () => {
    fake.advance(25);
  };
  const schedules = [new Schedule(100, 20), new Schedule(100, 20)] as const;
  const windows = scheduleWindows(...schedules);
  const offers: number[] = [];
  await driveWindows(
    schedules,
    windows,
    0,
    benchmarkClock(undefined, fake.host),
    () => {},
    (_phase, _slot, planned) => {
      offers.push(planned);
    },
  );
  assert.deepEqual(offers, [0, 20]);
  assert.deepEqual(
    windows.map((w) => [w.startMs, w.endMs, w.missed]),
    [
      [0, 20, 1],
      [20, 40, 1],
    ],
  );
});

test("cancellation interrupts a coarse wait and rejects before starting new work", async () => {
  const controller = new AbortController();
  const clock = benchmarkClock(controller.signal);
  const waiting = clock.sleep(10000);
  controller.abort(new Error("stop coarse wait"));
  await assert.rejects(waiting, { name: "AbortError" });
  await assert.rejects(clock.sleep(1), /stop coarse wait/);
});
