import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { files } from "./document-fixture.js";
import { runDocument } from "../../src/timeline/run-document.js";
import { checkCampaignRun } from "../../src/timeline/campaign-checks.js";
const jar = resolve(
  process.env.ZOOGLASS_SIMULATION_JAR ?? "../zooglass/target/zooglass.jar",
);

test("in-turn JVM pauses exceed freshness threshold without changing semantic trace, and campaign rejects absent evidence or divergence", async () => {
  const input = await files();
  try {
    const baseline = await runDocument(input.path, { jar });
    const mode = { hostDelay: 1, paced: true, idlePauseMs: 70, jvmPauseMs: 70 };
    const actual = await runDocument(input.path, { jar, ...mode });
    const expected = {
      draws: [],
      pauseTimes: {
        "writer-handoff": 0,
        "state-effect": 10,
        "alarm-dispatch": 60,
      },
    };
    checkCampaignRun(actual, baseline, mode, expected);
    const missing = structuredClone(actual);
    missing.diagnostics.jvm!.pauses = [];
    assert.throws(
      () => checkCampaignRun(missing, baseline, mode, expected),
      /pause site/,
    );
    const changed = structuredClone(actual);
    changed.trace = changed.trace.replace(
      '"status":"applied"',
      '"status":"rejected"',
    );
    assert.throws(
      () => checkCampaignRun(changed, baseline, mode, expected),
      /semantic trace divergence/,
    );
    const failed = structuredClone(actual);
    failed.outcome = "assertion-failed";
    assert.throws(
      () => checkCampaignRun(failed, baseline, mode, expected),
      /scenario failed/,
    );
  } finally {
    await input.close();
  }
});

test("JVM pause options reject before opening an artifact", async () => {
  const { Bridge } = await import("../../src/timeline/bridge.js");
  for (const value of [-1, 251, 1.5])
    await assert.rejects(
      Bridge.open("/missing.jar", 0, value),
      /Invalid JVM host pause/,
    );
});

test("long Node command-boundary pauses preserve traces within virtual timestamps", async () => {
  for (const name of ["warehouse-retry", "automatic-retry", "delayed-links"]) {
    const path = resolve(`scenarios/simulation/${name}.json`);
    const baseline = await runDocument(path, { jar });
    assert.equal(baseline.outcome, "passed");
    const hostDelay = name === "delayed-links" ? 90 : 70;
    const actual = await runDocument(path, { jar, hostDelay });
    assert.equal(actual.outcome, "passed", actual.message);
    assert.equal(actual.trace, baseline.trace);
    const pauses = actual.diagnostics.node;
    assert.ok(pauses.length > 1);
    assert.ok(
      pauses.every(
        (p) => p.requestedMillis === hostDelay && p.elapsedNanos > 50_000_000,
      ),
    );
    assert.ok(
      pauses.some((p, i) => i > 0 && p.timeMs === pauses[i - 1].timeMs),
    );
  }
});

test("Node pause options reject before opening an artifact", async () => {
  const { Bridge } = await import("../../src/timeline/bridge.js");
  for (const value of [-1, 251, 1.5])
    await assert.rejects(
      Bridge.open("/missing.jar", value),
      /Invalid Node host pause/,
    );
});
