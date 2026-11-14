import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { checkFleetCampaignRun } from "../../scripts/fleet-campaign-checks.js";
import { runDocument } from "../../src/timeline/run-document.js";

const expected = { assertions: 62, receipts: 16, frames: 28, records: 432 };
const unpaused = { hostDelay: 0, jvmPauseMs: 0, paced: false, idlePauseMs: 0 };
const jar = resolve(
  process.env.ZOOGLASS_SIMULATION_JAR ??
    "../zooglass/simulation-host/target/zooglass-simulation.jar",
);
test("fleet campaign checks independent outcomes and requires measured semantic-thread pauses", async () => {
  const baseline = await runDocument(
    resolve("scenarios/timeline-fleet/scenario.json"),
    { jar },
  );
  checkFleetCampaignRun(
    JSON.stringify(baseline),
    undefined,
    unpaused,
    expected,
  );
  const mode = { hostDelay: 70, jvmPauseMs: 90, paced: true, idlePauseMs: 70 };
  const paused = await runDocument(
    resolve("scenarios/timeline-fleet/scenario.json"),
    { jar, ...mode },
  );
  checkFleetCampaignRun(JSON.stringify(paused), baseline, mode, expected);
  const missing = structuredClone(paused);
  missing.diagnostics.generations![0].jvm!.pauses = [];
  assert.throws(
    () =>
      checkFleetCampaignRun(JSON.stringify(missing), baseline, mode, expected),
    /actual JVM state and writer pauses/,
  );
  const short = structuredClone(paused);
  short.diagnostics.generations![0].node[0].elapsedNanos = 1;
  assert.throws(
    () =>
      checkFleetCampaignRun(JSON.stringify(short), baseline, mode, expected),
    /measured Node pause too short/,
  );
  assert.throws(() =>
    checkFleetCampaignRun(
      JSON.stringify({ ...baseline, outcome: "assertion-failed" }),
      undefined,
      unpaused,
      expected,
    ),
  );
  const changed = structuredClone(baseline);
  changed.trace = changed.trace.replace('"passed":true', '"passed":false');
  assert.throws(() =>
    checkFleetCampaignRun(
      JSON.stringify(changed),
      undefined,
      unpaused,
      expected,
    ),
  );
  assert.throws(
    () =>
      checkFleetCampaignRun(JSON.stringify(baseline), undefined, unpaused, {
        ...expected,
        frames: 27,
      }),
    /complete client frame count/,
  );
});
