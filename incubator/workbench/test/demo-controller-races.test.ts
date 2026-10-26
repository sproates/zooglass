import assert from "node:assert/strict";
import test from "node:test";
import { deferred } from "./support/controller.js";
import { fileURLToPath } from "node:url";
import { createDemoController } from "../src/demo-controller.js";
import { loadScenario } from "../src/scenario.js";
import type { TraceEntry } from "../src/playback.js";

const scenario = await loadScenario(
  fileURLToPath(
    new URL("../scenarios/vehicle-browser-recovery.json", import.meta.url),
  ),
);

const boundaries: [string, (entry: TraceEntry) => boolean][] = [
  ["source delivery", (entry) => entry.kind === "source-event"],
  ["HTTP check", (entry) => entry.kind === "view-check"],
  ["snapshot check", (entry) => entry.kind === "client-view-check"],
  [
    "disconnect",
    (entry) => entry.kind === "client-state" && entry.state === "disconnected",
  ],
  [
    "reconnect",
    (entry) => entry.kind === "client-state" && entry.state === "connected",
  ],
  ["resubscribe", (entry) => entry.kind === "client-subscription"],
];

for (const [name, matches] of boundaries) {
  for (const action of ["reset", "close"] as const) {
    test(
      `${action} during ${name} drains the old action before cleanup`,
      { timeout: 5000 },
      async () => {
        const entered = deferred();
        const release = deferred();
        const log: string[] = [];
        let opens = 0;
        let armed = false;
        let blocked = false;
        let oldSignal: AbortSignal | undefined;
        const demo = createDemoController(scenario, async (signal) => {
          const id = ++opens;

          if (id === 1) oldSignal = signal;

          log.push(`open ${id}`);

          return {
            signal,
            publish() {},
            async execute(entry) {
              if (id === 1 && armed && !blocked && matches(entry)) {
                blocked = true;
                entered.resolve();
                await release.promise;
                log.push("old action settled");
                signal.throwIfAborted();
              }
            },
            async close() {
              log.push(`close ${id}`);
            },
          };
        });

        try {
          await demo.reset();
          armed = true;

          // Advance to the selected boundary; synchronise on entry, never a timer.
          let rejected: Promise<void> | undefined;

          while (!blocked && demo.state.phase === "ready") {
            const step = demo.step();
            const result = step.then(
              () => "finished" as const,
              () => "failed" as const,
            );
            const outcome = await Promise.race([
              result,
              entered.promise.then(() => "blocked" as const),
            ]);

            if (outcome === "blocked")
              rejected = assert.rejects(step, /replaced|closed/);
            else assert.equal(outcome, "finished");
          }

          assert.ok(blocked, `fixture never reached ${name}`);

          const stopping = demo[action]();

          assert.equal(oldSignal!.aborted, true);
          assert.equal(
            opens,
            1,
            "replacement must wait for the active operation",
          );
          assert.ok(
            !log.includes("close 1"),
            "cleanup must wait for the active operation",
          );
          release.resolve();
          await rejected;
          await stopping;

          assert.ok(log.indexOf("old action settled") < log.indexOf("close 1"));

          if (action === "reset") {
            assert.equal(opens, 2);
            assert.ok(log.indexOf("close 1") < log.indexOf("open 2"));
            assert.equal(demo.state.phase, "ready");
            assert.equal(demo.state.completed, 0);
            await demo.step();

            assert.equal(demo.state.completed, 1);
          } else {
            assert.equal(opens, 1);
            assert.equal(demo.state.phase, "closed");
            await assert.rejects(demo.reset(), /closed/);
          }
        } finally {
          release.resolve();
          await demo.close();
        }
      },
    );
  }
}
