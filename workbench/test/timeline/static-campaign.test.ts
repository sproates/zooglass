import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runDocument } from "../../src/timeline/run-document.js";
import { baselineMode, perturbedMode } from "../../scripts/static-campaign.js";
import { checkStaticRun } from "../../scripts/static-campaign-checks.js";

const jar = resolve(
  process.env.ZOOGLASS_SIMULATION_JAR ??
    "../zooglass/simulation-host/target/zooglass-simulation.jar",
);
test("static qualification requires independent literals, identical traces and measured long pauses", async () => {
  const path = "scenarios/timeline-static/mixed-modes/scenario.json";
  const scenario = await readFile(path, "utf8");
  const normal = await runDocument(path, { jar });
  const perturbed = await runDocument(path, { jar, ...perturbedMode });
  assert.equal(
    checkStaticRun(normal, scenario, undefined, baselineMode).assertions,
    14,
  );
  const counts = checkStaticRun(perturbed, scenario, normal, perturbedMode);
  assert.equal(counts.jvmPauses, 2);
  assert.ok(counts.nodePauses > 0);
  const nearRequested = structuredClone(perturbed);
  nearRequested.diagnostics.generations![0].node[0].elapsedNanos = 69_000_000;
  assert.doesNotThrow(() =>
    checkStaticRun(nearRequested, scenario, normal, perturbedMode),
  );
  for (const corrupt of [
    (run: typeof perturbed) => {
      run.outcome = "assertion-failed";
    },
    (run: typeof perturbed) => {
      run.diagnostics.generations![0].node = [];
    },
    (run: typeof perturbed) => {
      run.diagnostics.generations![0].jvm!.pauses = [];
    },
    (run: typeof perturbed) => {
      run.diagnostics.generations![0].node[0].elapsedNanos = 1;
    },
    (run: typeof perturbed) => {
      run.trace = run.trace.replace('"temperatureC":760', '"temperatureC":999');
    },
  ]) {
    const changed = structuredClone(perturbed);
    corrupt(changed);
    assert.throws(() =>
      checkStaticRun(changed, scenario, normal, perturbedMode),
    );
  }
  const changed = JSON.parse(scenario);
  changed.assertions.find(
    (item: { id: string }) => item.id === "data-a-11",
  ).expected.latest.sample = "wrong";
  assert.throws(
    () =>
      checkStaticRun(normal, JSON.stringify(changed), undefined, baselineMode),
    /reviewed scenario/,
  );
});

test("converted scenarios without subscriptions require state pauses but no client writer pause", async () => {
  const path = "scenarios/timeline-static/live-match/scenario.json";
  const scenario = await readFile(path, "utf8");
  const run = await runDocument(path, { jar, ...perturbedMode });
  assert.equal(
    checkStaticRun(run, scenario, undefined, perturbedMode).jvmPauses,
    1,
  );
});
