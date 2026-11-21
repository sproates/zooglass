import assert from "node:assert/strict";
import { mkdir, readFile, copyFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runDocument } from "../src/timeline/run-document.js";
import { parseReplay } from "../src/timeline/replay-document.js";
import type { DocumentRun } from "../src/timeline/campaign-checks.js";
import { readRecoveryPreparation } from "./recovery-preparation.js";
import {
  cleanRecoverySource,
  digest,
  git,
  workbench,
  writeEvidence,
} from "./recovery-evidence.js";

export function checkRecoveryControl(normal: DocumentRun, mutant: DocumentRun) {
  assert.equal(normal.outcome, "passed");
  assert.equal(mutant.outcome, "assertion-failed");
  assert.equal(mutant.message, "assertion-failed: restored-a");
  assert.equal(normal.scenario, mutant.scenario);
  assert.equal(normal.configuration, mutant.configuration);
  assert.deepEqual(normal.environment, mutant.environment);
  assert.deepEqual(mutant.execution, {
    ...normal.execution,
    artifactSha256: mutant.execution.artifactSha256,
  });
  assert.notEqual(
    normal.execution.artifactSha256,
    mutant.execution.artifactSha256,
  );
  const good = parseReplay(JSON.stringify(normal)).lines.map((line) =>
    JSON.parse(line),
  );
  const bad = parseReplay(JSON.stringify(mutant)).lines.map((line) =>
    JSON.parse(line),
  );
  const prior = (records: typeof good) =>
    records.filter((r) => r.key && r.key[0] < 60);
  assert.deepEqual(prior(bad), prior(good), "mutation diverged before restart");
  const started = bad.find(
    (r) => r.kind === "runtime-initialized" && r.runtimeGeneration === 2,
  );
  assert.ok(started, "mutant must successfully initialize generation 2");
  assert.equal(started.key[0], 60);
  const checkpoint = (records: typeof good) =>
    records.find(
      (r) => r.kind === "assertion" && r.data.assertionId === "restored-a",
    );
  const passing = checkpoint(good),
    failing = checkpoint(bad);
  assert.equal(passing.data.passed, true);
  assert.equal(failing.data.passed, false);
  assert.equal(failing.runtimeGeneration, 2);
  assert.equal(failing.key[0], 60);
  assert.deepEqual(failing.data.expected, passing.data.expected);
  assert.equal(passing.data.actual.snapshot.version, 4);
  assert.equal(failing.data.actual.outcome, "available");
  assert.equal(failing.data.actual.snapshot.version, 0);
  assert.deepEqual(failing.data.actual.snapshot.data, {});
  return {
    failedAssertion: "restored-a",
    generation: 2,
    atMs: 60,
    expectedVersion: 4,
    actualVersion: 0,
  };
}

export async function runRecoveryControl(prepared: string, output: string) {
  const source = await cleanRecoverySource();
  const preparation = resolve(prepared),
    directory = resolve(output);
  const control = await readRecoveryPreparation(preparation);
  assert.equal(
    git("rev-parse", `${control.provenance.revision}:zooglass`),
    source.javaSourceTree,
    "prepared runtime/host sources differ",
  );
  await mkdir(directory);
  for (const file of [
    "preparation.json",
    "recovery-original.java",
    "recovery-mutant.java",
  ])
    await copyFile(join(preparation, file), join(directory, file));
  const fixture = join(workbench, "scenarios/timeline-static-recovery/s1");
  for (const file of ["scenario.json", "runtime.json"])
    await copyFile(join(fixture, file), join(directory, file));
  for (const file of [
    "prepare-static-recovery-mutation.py",
    "prepare-generation-clock-mutation.py",
  ])
    await copyFile(join(workbench, "scripts", file), join(directory, file));
  await writeEvidence(join(directory, "inventories.json"), control.inventories);
  const diagnosticDirectory = join(preparation, "diagnostics");
  await mkdir(diagnosticDirectory, { recursive: true });
  const runs = {} as Record<"normal" | "mutant", DocumentRun>;
  let details;
  let failure: string | undefined;
  try {
    for (const name of ["normal", "mutant"] as const) {
      const jar = join(preparation, `${name}.jar`);
      const run = await runDocument(join(directory, "scenario.json"), {
        jar,
        diagnosticDirectory,
      });
      runs[name] = run;
      await writeEvidence(join(directory, `${name}.json`), run);
      assert.equal(
        run.execution.artifactSha256,
        control.provenance.artifacts[name],
      );
      assert.equal(
        digest(await readFile(jar)),
        control.provenance.artifacts[name],
      );
      assert.equal(run.execution.workbenchSha256, source.workbenchSha256);
    }
    details = checkRecoveryControl(runs.normal, runs.mutant);
    assert.deepEqual(await cleanRecoverySource(), source);
  } catch (error) {
    failure = String(error);
  }
  const summary = {
    format: "timeline-static-recovery-control/v1",
    source,
    preparationRevision: control.provenance.revision,
    preparationSha256: digest(control.manifest),
    artifacts: control.provenance.artifacts,
    scenarioExecutions: Object.keys(runs).length,
    complete: failure === undefined && details !== undefined,
    details,
    ...(failure ? { failure } : {}),
  };
  await writeEvidence(join(directory, "summary.json"), summary);
  assert.ok(summary.complete, failure ?? "incomplete qualification");
  return summary;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [prepared, output, ...extra] = process.argv.slice(2);
  assert.ok(
    prepared && output && !extra.length,
    "Usage: recovery-control PREPARED_DIRECTORY NEW_DIRECTORY",
  );
  await runRecoveryControl(prepared, output);
}
