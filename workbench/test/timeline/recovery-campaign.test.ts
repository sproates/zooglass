import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runDocument } from "../../src/timeline/run-document.js";
import { baselineMode, perturbedMode } from "../../scripts/static-campaign.js";
import { checkRecoveryRun } from "../../scripts/recovery-campaign-checks.js";

const jar = resolve(
  process.env.ZOOGLASS_SIMULATION_JAR ??
    "../zooglass/simulation-host/target/zooglass-simulation.jar",
);
for (const name of ["m1", "s3"]) {
  test(`recovery qualification checks every ${name} generation against independent observations`, async () => {
    const path = `scenarios/timeline-static-recovery/${name}/scenario.json`;
    const scenario = await readFile(path, "utf8");
    const normal = await runDocument(path, { jar });
    const paused = await runDocument(path, { jar, ...perturbedMode });
    checkRecoveryRun(name, normal, scenario, undefined, baselineMode);
    const counts = checkRecoveryRun(
      name,
      paused,
      scenario,
      normal,
      perturbedMode,
    );
    assert.equal(counts.attempts, name === "m1" ? 6 : 10);
    assert.equal(counts.jvmPauses, name === "m1" ? 4 : 5);
    for (const corrupt of [
      (run: typeof paused) => {
        run.diagnostics.generations!.pop();
      },
      (run: typeof paused) => {
        run.diagnostics.generations![1].runtimeGeneration = 1;
      },
      (run: typeof paused) => {
        run.diagnostics.generations![1].node = [];
      },
      (run: typeof paused) => {
        run.diagnostics.generations![1].jvm!.pauses = [];
      },
      (run: typeof paused) => {
        run.diagnostics.generations![1].jvm!.pauses[0].virtualMs++;
      },
      (run: typeof paused) => {
        run.diagnostics.generations![1].node[0].elapsedNanos = 1;
      },
      (run: typeof paused) => {
        run.diagnostics.generations![1].jvm!.pauses[0].elapsedNanos = 1;
      },
      (run: typeof paused) => {
        run.trace = run.trace.replace(
          '"temperatureC":760',
          '"temperatureC":999',
        );
      },
      (run: typeof paused) => {
        run.outcome = "assertion-failed";
      },
    ]) {
      const changed = structuredClone(paused);
      corrupt(changed);
      assert.throws(() =>
        checkRecoveryRun(name, changed, scenario, normal, perturbedMode),
      );
    }
    const altered = JSON.parse(scenario);
    altered.assertions.find(
      (a: { id: string }) => a.id === "data-a-11",
    ).expected.latest.sample = "wrong";
    assert.throws(
      () =>
        checkRecoveryRun(
          name,
          normal,
          JSON.stringify(altered),
          undefined,
          baselineMode,
        ),
      /reviewed scenario/,
    );
  });
}
