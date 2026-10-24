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
