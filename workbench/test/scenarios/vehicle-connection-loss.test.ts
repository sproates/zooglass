import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { loadScenario, parseScenario } from "../../src/scenario/scenario.js";
import { playScenario } from "../../src/scenario/playback.js";
import { planDemoSteps } from "../../src/control/demo-steps.js";
import { openScenarioSession } from "../../src/execution/scenario-session.js";

const fixture = "scenarios/browser/vehicle-connection-loss.json";

test("fault fixture separates outage/source/restore checkpoints without explicit reconnect commands", async () => {
  const scenario = await loadScenario(fixture);
  const { steps } = planDemoSteps(playScenario(scenario));
  assert.equal(steps.length, 8);
  assert.equal(steps[5].entries[0].kind, "data-connection-fault");
  assert.equal(steps[6].entries[0].kind, "source-event");
  assert.equal(steps[7].entries[0].kind, "data-connection-fault");
  assert.deepEqual(
    steps[6].entries
      .filter((e) => e.kind === "view-check")
      .map((e) => e.viewId)
      .sort(),
    ["live-map", "trip-history"],
  );
  assert.deepEqual(
    steps[7].entries.map((e) => e.kind),
    ["data-connection-fault", "client-view-check", "client-view-check"],
  );
  assert.equal(
    scenario.timeline.filter((e) => e.kind === "client-state").length,
    1,
  );
});

test("fault parser rejects unknown clients, invalid actions and unsupported timeout values", async () => {
  const original = JSON.parse(await readFile(fixture, "utf8"));
  for (const change of [
    { clientId: "missing" },
    { action: "pause" },
    { timeoutMs: 0 },
    { timeoutMs: 30001 },
    { action: "restore", timeoutMs: 1000 },
  ]) {
    const input = structuredClone(original);
    Object.assign(
      input.timeline.find(
        (e: { kind: string }) => e.kind === "data-connection-fault",
      ),
      change,
    );
    assert.throws(
      () => parseScenario(input),
      /unknown client|action|timeoutMs/,
    );
  }
});

test("Node-only session and CLI reject faults before opening sockets or starting ZooGlass", async () => {
  const scenario = await loadScenario(fixture);
  let allocated = false;
  await assert.rejects(
    openScenarioSession(scenario, "http://127.0.0.1:1", {
      createClientExecutor() {
        allocated = true;
        throw new Error("must not allocate");
      },
    }),
    /Node-only execution is unsupported/,
  );
  assert.equal(allocated, false);
  await assert.rejects(
    promisify(execFile)(process.execPath, [
      "--import",
      "tsx",
      "src/cli/integrate.ts",
      fixture,
    ]),
    (error: unknown) => {
      const result = error as { code: number; stdout: string; stderr: string };
      assert.equal(result.code, 1);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /Node-only execution is unsupported/);
      return true;
    },
  );
});
