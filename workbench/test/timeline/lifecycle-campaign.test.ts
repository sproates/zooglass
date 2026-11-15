import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { checkLifecycleCampaignRun } from "../../scripts/lifecycle-campaign-checks.js";
import { lifecycleCampaignInputs } from "../../scripts/lifecycle-campaign-inputs.js";
import { canonicalJson } from "../../src/timeline/json.js";
import { runDocument } from "../../src/timeline/run-document.js";

const jar = resolve(
  process.env.ZOOGLASS_SIMULATION_JAR ??
    "../zooglass/simulation-host/target/zooglass-simulation.jar",
);

test("the lifecycle oracle rejects changed clocks, loss evidence, outcomes and unobserved host pauses", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "lifecycle-campaign-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const { groups } = await lifecycleCampaignInputs(directory);
  const abrupt = groups.find((group) => group.id === "abrupt");
  assert.ok(abrupt);

  const unpaused = {
    hostDelay: 0,
    jvmPauseMs: 0,
    paced: false,
    idlePauseMs: 0,
  };
  const mode = { hostDelay: 55, jvmPauseMs: 55, paced: true, idlePauseMs: 55 };
  const baseline = await runDocument(abrupt.path, { jar });
  const actual = await runDocument(abrupt.path, { jar, ...mode });
  checkLifecycleCampaignRun(
    JSON.stringify(baseline),
    undefined,
    unpaused,
    abrupt.expected,
  );
  checkLifecycleCampaignRun(
    JSON.stringify(actual),
    baseline,
    mode,
    abrupt.expected,
  );

  await context.test(
    "both pause sites and actual durations are required after restart",
    () => {
      const missing = structuredClone(actual);
      missing.diagnostics.generations![1].jvm!.pauses = [];
      assert.throws(
        () =>
          checkLifecycleCampaignRun(
            JSON.stringify(missing),
            baseline,
            mode,
            abrupt.expected,
          ),
        /JVM pause sites/,
      );

      const short = structuredClone(actual);
      short.diagnostics.generations![1].node.find(
        (pause) => pause.operation === "ingress",
      )!.elapsedNanos = 1;
      assert.throws(
        () =>
          checkLifecycleCampaignRun(
            JSON.stringify(short),
            baseline,
            mode,
            abrupt.expected,
          ),
        /observed Node pause duration/,
      );

      const missingIngress = structuredClone(actual);
      const restarted = missingIngress.diagnostics.generations![1];
      restarted.node = restarted.node.filter(
        (pause) => pause.operation !== "ingress",
      );
      assert.throws(
        () =>
          checkLifecycleCampaignRun(
            JSON.stringify(missingIngress),
            baseline,
            mode,
            abrupt.expected,
          ),
        /restarted ingress/,
      );
    },
  );

  await context.test(
    "passing output is compared against independent vectors even without a baseline",
    () => {
      const lines = baseline.trace.trimEnd().split("\n");
      const faultIndex = lines.findIndex(
        (line) => JSON.parse(line).kind === "fault-decision",
      );
      const fault = JSON.parse(lines[faultIndex]);
      // Leave the sample and decision internally consistent while substituting an incorrect digest.
      fault.data.digest = `${fault.data.digest.slice(0, 8)}${"f".repeat(56)}`;
      lines[faultIndex] = canonicalJson(JSON.stringify(fault));
      const changed = JSON.stringify({
        ...baseline,
        trace: lines.join("\n") + "\n",
      });
      assert.throws(
        () =>
          checkLifecycleCampaignRun(
            changed,
            undefined,
            unpaused,
            abrupt.expected,
          ),
        /independent receipt-loss draw vectors/,
      );
      assert.throws(
        () =>
          checkLifecycleCampaignRun(
            changed,
            baseline,
            unpaused,
            abrupt.expected,
          ),
        new RegExp(`semantic trace divergence at record ${faultIndex}`),
      );
    },
  );

  await context.test(
    "impossible generation clocks and failing outcomes cannot qualify",
    () => {
      const lines = baseline.trace.trimEnd().split("\n");
      const initIndex = lines.findIndex((line) => {
        const event = JSON.parse(line);
        return (
          event.kind === "runtime-initialized" && event.runtimeGeneration === 2
        );
      });
      const init = JSON.parse(lines[initIndex]);
      init.data.wallMillis++;
      lines[initIndex] = canonicalJson(JSON.stringify(init));
      const wrongClock = JSON.stringify({
        ...baseline,
        trace: lines.join("\n") + "\n",
      });
      assert.throws(
        () =>
          checkLifecycleCampaignRun(
            wrongClock,
            undefined,
            unpaused,
            abrupt.expected,
          ),
        /initialization wall clock/,
      );
      const failed = JSON.stringify({
        ...baseline,
        outcome: "assertion-failed",
        message: "literal scenario failed",
      });
      assert.throws(
        () =>
          checkLifecycleCampaignRun(
            failed,
            undefined,
            unpaused,
            abrupt.expected,
          ),
        /literal scenario failed/,
      );
    },
  );
});
