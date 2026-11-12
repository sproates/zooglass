import assert from "node:assert/strict";
import test from "node:test";
import { createCheckpointController } from "../src/control/prepared-checkpoints.js";
import type { DemoState } from "../src/control/demo-controller.js";
import { deferred } from "./support/controller.js";

test("prepared checkpoints publish failed startup and retry without an active run", async () => {
  const states: DemoState[] = [];
  let fail = true;
  let executions = 0;
  const controller = createCheckpointController(
    [
      {
        id: "first",
        label: "First check",
        async execute() {
          executions++;
        },
      },
    ],
    async (signal) => {
      if (fail) throw new Error("Service unavailable");
      return { signal, async close() {} };
    },
    (state) => states.push(state),
  );
  try {
    await assert.rejects(controller.reset(), /Service unavailable/);
    assert.deepEqual(
      states.map(({ phase }) => phase),
      ["resetting", "failed"],
    );
    assert.match(states.at(-1)!.detail, /Service unavailable/);
    fail = false;
    await controller.reset();
    await controller.step();
    assert.equal(executions, 1);
    assert.deepEqual(
      states.slice(2).map(({ phase }) => phase),
      ["resetting", "ready", "stepping", "complete"],
    );
  } finally {
    await controller.close();
  }
  assert.equal(states.at(-1)!.phase, "closed");
});

test("closing a prepared checkpoint startup publishes closed without a stale ready state", async () => {
  const states: DemoState[] = [];
  const entered = deferred();
  const controller = createCheckpointController(
    [{ id: "first", label: "First check", async execute() {} }],
    async (signal) => {
      entered.resolve();
      await new Promise<void>((_, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        }),
      );
      return { signal, async close() {} };
    },
    (state) => states.push(state),
  );
  const reset = assert.rejects(controller.reset(), /closed/);
  await entered.promise;
  await controller.close();
  await reset;
  assert.deepEqual(
    states.map(({ phase }) => phase),
    ["resetting", "closed"],
  );
});
