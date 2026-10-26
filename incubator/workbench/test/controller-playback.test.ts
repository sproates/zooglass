import assert from "node:assert/strict";
import test from "node:test";
import { createDemoController } from "../src/control/demo-controller.js";
import { basicScenario, deferred } from "./support/controller.js";

const scenario = await basicScenario();

test("pause lets an active checkpoint finish, rejects overlap, and resumes in order", async () => {
  const entered = deferred();
  const blocked = deferred();
  const sent: number[] = [];
  const fast = structuredClone(scenario);

  fast.timeline = fast.timeline.map((entry) => ({
    ...entry,
    simulationTime: 0,
  }));

  const demo = createDemoController(fast, async (signal) => ({
    signal,
    publish() {},
    async close() {},
    async execute(entry) {
      if (entry.kind === "source-event")
        sent.push(entry.payload.sequence as number);

      if (entry.kind === "view-check" && sent.length === 1) {
        entered.resolve();
        await blocked.promise;
      }
    },
  }));

  try {
    await demo.reset();
    await demo.play();
    await entered.promise;

    await assert.rejects(demo.play(), /idle/);
    await assert.rejects(demo.step(), /idle/);

    const paused = demo.pause();

    assert.equal(demo.state.completed, 0);
    await assert.rejects(demo.pause(), /active/);
    blocked.resolve();
    await paused;

    assert.deepEqual(sent, [40]);
    assert.equal(demo.state.completed, 1);
    assert.equal(demo.state.playing, false);
    await demo.play();
    await waitUntil(() => demo.state.phase === "complete");

    assert.deepEqual(sent, [40, 42]);
  } finally {
    blocked.resolve();
    await demo.close();
  }
});

async function waitUntil(condition: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, "controller did not settle");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("pause freezes the remaining delay; reset and close cancel scheduled delivery", async () => {
  const sent: number[] = [];
  const demo = createDemoController(scenario, async (signal) => ({
    signal,
    publish() {},
    async close() {},
    async execute(entry) {
      if (entry.kind === "source-event")
        sent.push(entry.payload.sequence as number);
    },
  }));

  try {
    await demo.reset();
    await demo.play();
    await demo.pause();
    await new Promise((resolve) => setTimeout(resolve, 1100));

    assert.deepEqual(sent, []);
    await demo.play();
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.deepEqual(sent, [], "paused wall time must not consume the delay");
    await demo.reset();

    assert.equal(demo.state.playing, false);
    await demo.step();

    assert.deepEqual(sent, [40]);
    await demo.play();
    await demo.close();
    await new Promise((resolve) => setTimeout(resolve, 1100));

    assert.deepEqual(sent, [40], "no old timer may send after reset or close");
  } finally {
    await demo.close();
  }
});

test("playback check failure stops scheduling and reset clears playback", async () => {
  const fast = structuredClone(scenario);

  fast.timeline = fast.timeline.map((entry) => ({
    ...entry,
    simulationTime: 0,
  }));

  const sent: number[] = [];
  const demo = createDemoController(fast, async (signal) => ({
    signal,
    publish() {},
    async close() {},
    async execute(entry) {
      if (entry.kind === "source-event")
        sent.push(entry.payload.sequence as number);

      if (entry.kind === "view-check") throw new Error("bad checkpoint");
    },
  }));

  try {
    await demo.reset();
    await demo.play();
    await waitUntil(() => demo.state.phase === "failed");

    assert.deepEqual(sent, [40]);
    assert.equal(demo.state.playing, false);
    assert.equal(demo.state.completed, 0);
    await demo.reset();

    assert.equal(demo.state.phase, "ready");
    assert.equal(demo.state.playing, false);
  } finally {
    await demo.close();
  }
});
