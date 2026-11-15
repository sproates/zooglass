import assert from "node:assert/strict";
import { mkdir, readFile, copyFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runDocument } from "../src/timeline/run-document.js";
import { parseReplay } from "../src/timeline/replay-document.js";
import type { DocumentRun } from "../src/timeline/campaign-checks.js";
import { readLatestSelectionPreparation } from "./fleet-strategy-check.js";
import {
  cleanSource,
  digest,
  git,
  workbench,
  writeEvidence,
} from "./static-evidence.js";

export function checkStaticSelectionControl(
  normal: DocumentRun,
  mutant: DocumentRun,
) {
  assert.equal(normal.outcome, "passed");
  assert.equal(mutant.outcome, "assertion-failed");
  assert.equal(mutant.message, "assertion-failed: data-a-11");
  assert.equal(normal.scenario, mutant.scenario);
  assert.equal(normal.configuration, mutant.configuration);
  assert.deepEqual(normal.environment, mutant.environment);
  assert.equal(
    normal.execution.workbenchSha256,
    mutant.execution.workbenchSha256,
  );
  const good = parseReplay(JSON.stringify(normal)).lines.map((line) =>
    JSON.parse(line),
  );
  const bad = parseReplay(JSON.stringify(mutant)).lines.map((line) =>
    JSON.parse(line),
  );
  const beforeLate = (records: typeof good) =>
    records.filter((record) => record.key && record.key[0] < 30);
  assert.deepEqual(
    beforeLate(good),
    beforeLate(bad),
    "control diverged before the older update",
  );
  const atLate = (records: typeof good) =>
    records.find(
      (record) =>
        record.kind === "assertion" && record.data.assertionId === "data-a-11",
    );
  const passing = atLate(good),
    failing = atLate(bad);
  assert.equal(passing.data.passed, true);
  assert.equal(failing.data.passed, false);
  assert.equal(failing.key[0], 30);
  assert.deepEqual(failing.data.expected, passing.data.expected);
  assert.deepEqual(passing.data.actual.latest, {
    temperatureC: 760,
    sample: "A12",
  });
  assert.deepEqual(failing.data.actual.latest, {
    temperatureC: 740,
    sample: "A11",
  });
  for (const field of ["arrival", "history"])
    assert.deepEqual(failing.data.actual[field], passing.data.actual[field]);
  return {
    failedAssertion: "data-a-11",
    atMs: 30,
    expectedSample: "A12",
    actualSample: "A11",
  };
}

export async function runStaticSelectionControl(
  prepared: string,
  output: string,
) {
  const source = await cleanSource();
  const preparation = resolve(prepared),
    directory = resolve(output);
  const control = await readLatestSelectionPreparation(preparation);
  assert.equal(
    git("rev-parse", `${control.provenance.revision}:zooglass`),
    source.javaSourceTree,
    "prepared runtime/host sources differ",
  );
  await mkdir(directory);
  for (const file of [
    "preparation.json",
    "strategy-original.java",
    "strategy-mutant.java",
  ])
    await copyFile(join(preparation, file), join(directory, file));
  const fixture = join(workbench, "scenarios/timeline-static/mixed-modes");
  for (const file of ["scenario.json", "runtime.json", "ORACLE.md"])
    await copyFile(join(fixture, file), join(directory, file));
  const runs = {} as Record<"normal" | "mutant", DocumentRun>;
  let details;
  let failure: string | undefined;
  try {
    for (const name of ["normal", "mutant"] as const) {
      const jar = join(preparation, `${name}.jar`);
      const run = await runDocument(join(directory, "scenario.json"), { jar });
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
    details = checkStaticSelectionControl(runs.normal, runs.mutant);
    assert.deepEqual(await cleanSource(), source);
  } catch (error) {
    failure = String(error);
  }
  const summary = {
    format: "timeline-static-selection-control/v1",
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
    "Usage: static-selection-control PREPARED_DIRECTORY NEW_DIRECTORY",
  );
  await runStaticSelectionControl(prepared, output);
}
