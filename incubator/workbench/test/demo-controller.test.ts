import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createDemoController,
  DemoCleanupError,
  type DemoRun,
} from "../src/demo-controller.js";
import { loadScenario } from "../src/scenario.js";
import type { TraceEntry } from "../src/playback.js";
const scenario = await loadScenario(
  fileURLToPath(
    new URL("../scenarios/vehicle-browser-basic.json", import.meta.url),
  ),
);
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

test("step waits for checks, rejects overlap, and reset invalidates the active run before replacement", async () => {
  const blocked = deferred();
  const entered = deferred();
  const cleanup = deferred();
  const executions: TraceEntry[][] = [];
  let opens = 0;
  const demo = createDemoController(
    scenario,
    async (signal): Promise<DemoRun> => {
      const index = opens++;
      const entries: TraceEntry[] = [];
      executions.push(entries);
      return {
        signal,
        async execute(entry) {
          entries.push(entry);
          if (index === 0 && entry.kind === "view-check") {
            entered.resolve();
            await blocked.promise;
          }
        },
        async close() {
          if (index === 0) await cleanup.promise;
        },
        publish() {},
      };
    },
  );
  await demo.reset();
  assert.equal(demo.state.phase, "ready");
  assert.ok(executions[0].every((entry) => entry.kind !== "source-event"));
  const step = demo.step();
  const rejected = assert.rejects(step, /replaced/);
  await entered.promise;
  await assert.rejects(demo.step(), /idle/);
  const reset = demo.reset();
  await assert.rejects(demo.reset(), /already running/);
  blocked.resolve();
  await rejected;
  assert.equal(opens, 1, "cleanup must finish before replacement starts");
  cleanup.resolve();
  await reset;
  assert.equal(demo.state.completed, 0);
  assert.equal(opens, 2);
  assert.equal(
    executions[0].filter((entry) => entry.kind === "view-check").length,
    1,
    "old checks cannot continue",
  );
  await demo.step();
  assert.equal(demo.state.completed, 1);
  assert.equal(demo.state.phase, "ready");
  await demo.step();
  assert.equal(demo.state.phase, "complete");
  await assert.rejects(demo.step(), /idle/);
  await demo.close();
  await demo.close();
});

test("failed checks stop progress; reset starts from empty; cleanup failure prevents replacement", async () => {
  let failCheck = true;
  let failClose = false;
  let opens = 0;
  const demo = createDemoController(scenario, async (signal) => {
    opens++;
    return {
      signal,
      publish() {},
      async execute(entry) {
        if (entry.kind === "view-check" && failCheck)
          throw new Error("Check failed");
      },
      async close() {
        if (failClose) throw new Error("Process still running");
      },
    };
  });
  await demo.reset();
  await assert.rejects(demo.step(), /Check failed/);
  assert.equal(demo.state.completed, 0);
  assert.equal(demo.state.phase, "failed");
  await assert.rejects(demo.step(), /idle/);
  failCheck = false;
  await demo.reset();
  await demo.step();
  failClose = true;
  await assert.rejects(demo.reset(), /Process still running/);
  assert.equal(opens, 2);
  await assert.rejects(demo.reset(), /Cleanup failed/);
  failClose = false;
  await demo.close();
});

test("closing during startup cancels acquisition and never enables the new run", async () => {
  const entered = deferred();
  const demo = createDemoController(scenario, async (signal) => {
    entered.resolve();
    await new Promise<void>((_, reject) =>
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      }),
    );
    throw new Error("unreachable");
  });
  const reset = demo.reset();
  const rejected = assert.rejects(reset, /closed/);
  await entered.promise;
  await demo.close();
  await rejected;
  assert.equal(demo.state.phase, "closed");
});

test("failed partial-startup cleanup blocks a replacement run", async () => {
  let opens = 0;
  const demo = createDemoController(scenario, async () => {
    opens++;
    throw new DemoCleanupError("Startup resources did not close");
  });
  await assert.rejects(demo.reset(), /did not close/);
  await assert.rejects(demo.reset(), /Cleanup failed/);
  assert.equal(opens, 1);
  await demo.close();
});

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

test("manual intervention is serialised, exploratory and reset restores checked playback", async () => {
  const blocked = deferred();
  const entered = deferred();
  const executed: TraceEntry[] = [];
  let manual = false;
  const demo = createDemoController(scenario, async (signal) => ({
    signal,
    publish() {},
    async close() {},
    async execute(entry) {
      executed.push(entry);
      if (manual && entry.kind === "client-state") {
        entered.resolve();
        await blocked.promise;
      }
    },
  }));
  try {
    await demo.reset();
    manual = true;
    const pending = demo.intervene("Disconnect viewer", [
      {
        kind: "client-state",
        simulationTime: 0,
        clientId: "rider-app",
        clientName: "Viewer",
        state: "disconnected",
      },
    ]);
    await entered.promise;
    await assert.rejects(demo.step(), /idle/);
    await assert.rejects(demo.play(), /idle/);
    await assert.rejects(demo.intervene("overlap", []), /idle/);
    assert.equal(demo.state.completed, 0);
    blocked.resolve();
    await pending;
    await demo.step();
    await demo.step();
    assert.equal(demo.state.phase, "complete");
    assert.equal(demo.state.exploratory, true);
    assert.equal(demo.state.skippedChecks, 4);
    assert.equal(
      executed.filter((e) => e.kind === "client-view-check").length,
      0,
    );
    assert.equal(executed.filter((e) => e.kind === "view-check").length, 4);
    assert.match(demo.state.detail, /not a scripted pass/);
    manual = false;
    await demo.reset();
    assert.equal(demo.state.exploratory, false);
    assert.equal(demo.state.interventions, 0);
    assert.equal(demo.state.skippedChecks, 0);
    await demo.step();
    assert.equal(
      executed.filter((e) => e.kind === "client-view-check").length,
      2,
    );
  } finally {
    blocked.resolve();
    await demo.close();
  }
});

test("reset cancels an intervention before a new baseline can start", async () => {
  const entered = deferred();
  let manual = false;
  const demo = createDemoController(scenario, async (signal) => ({
    signal,
    publish() {},
    async close() {},
    async execute() {
      if (manual) {
        entered.resolve();
        await new Promise<void>((_, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          }),
        );
      }
    },
  }));
  try {
    await demo.reset();
    manual = true;
    const action = demo.intervene("Disconnect", [
      {
        kind: "client-state",
        simulationTime: 0,
        clientId: "rider-app",
        clientName: "Viewer",
        state: "disconnected",
      },
    ]);
    const rejected = assert.rejects(action, /replaced/);
    await entered.promise;
    manual = false;
    await demo.reset();
    await rejected;
    assert.equal(demo.state.exploratory, false);
    assert.equal(demo.state.phase, "ready");
    await demo.play();
    await assert.rejects(demo.intervene("Disconnect", []), /paused/);
    await demo.pause();
  } finally {
    await demo.close();
  }
});
