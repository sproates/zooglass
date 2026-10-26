import assert from "node:assert/strict";
import test from "node:test";
import { createDemoController } from "../src/demo-controller.js";
import type { TraceEntry } from "../src/playback.js";
import { basicScenario, deferred } from "./support/controller.js";

const scenario = await basicScenario();

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
