/** Fixed six-case, two-mode qualification. No builds and no seed multiplier. */
import assert from "node:assert/strict";
import { cp, mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runDocument } from "../src/timeline/run-document.js";
import { parseReplay, replaySaved } from "../src/timeline/replay-document.js";
import type {
  CampaignMode,
  DocumentRun,
} from "../src/timeline/campaign-checks.js";
import { checkStaticRun } from "./static-campaign-checks.js";
import {
  cleanSource,
  digest,
  staticCases,
  workbench,
  writeEvidence,
} from "./static-evidence.js";

import { jarInventory, readJar } from "./control-evidence.js";

export const baselineMode: CampaignMode = {
  hostDelay: 0,
  jvmPauseMs: 0,
  paced: false,
  idlePauseMs: 0,
};
export const perturbedMode: CampaignMode = {
  hostDelay: 70,
  jvmPauseMs: 90,
  paced: true,
  idlePauseMs: 70,
};

export async function runStaticCampaign(output: string, preparedJar: string) {
  const source = await cleanSource();
  const directory = resolve(output),
    jar = resolve(preparedJar);
  const artifactSha256 = digest(await readFile(jar));
  const inventory = await jarInventory(await readJar(jar));
  const embedded = [...inventory.keys()].filter((name) =>
    /^BOOT-INF\/lib\/zooglass-[\w.-]+-runtime\.jar$/.test(name),
  );
  assert.equal(embedded.length, 1, "single embedded production runtime");
  const runtimeSha256 = inventory.get(embedded[0])!;
  await mkdir(directory);
  await cp(
    join(workbench, "scenarios/timeline-static"),
    join(directory, "inputs"),
    { recursive: true, errorOnExist: true, force: false },
  );
  const rows = [];
  let attemptedExecutions = 0;
  let scenarioExecutions = 0;
  let failure: string | undefined;
  try {
    for (const name of staticCases) {
      let baseline: DocumentRun | undefined;
      const scenario = join(directory, "inputs", name, "scenario.json");
      const bytes = await readFile(scenario, "utf8");
      for (const [label, mode] of [
        ["baseline", baselineMode],
        ["perturbed", perturbedMode],
      ] as const) {
        attemptedExecutions++;
        const run = await runDocument(scenario, { jar, ...mode });
        scenarioExecutions++;
        const file = `${name}-${label}.json`;
        await writeEvidence(join(directory, file), run);
        const counts = checkStaticRun(run, bytes, baseline, mode);
        assert.equal(run.execution.artifactSha256, artifactSha256);
        assert.equal(run.execution.workbenchSha256, source.workbenchSha256);
        if (!baseline) baseline = run;
        // Replay uses a fresh JVM and compares every new record. Retain its actual run too.
        attemptedExecutions++;
        const replay = await replaySaved(parseReplay(JSON.stringify(run)), {
          jar,
        });
        scenarioExecutions++;
        const replayFile = `${name}-${label}-replay.json`;
        await writeEvidence(join(directory, replayFile), replay);
        assert.equal(replay.status, "verified");
        assert.equal(replay.recordedOutcome, "passed");
        assert.equal(replay.actual.outcome, "passed");
        rows.push({
          name,
          mode: label,
          options: mode,
          file,
          sha256: digest(await readFile(join(directory, file))),
          replayFile,
          replaySha256: digest(await readFile(join(directory, replayFile))),
          traceSha256: digest(run.trace),
          ...counts,
        });
        console.log(`Verified ${name}/${label} and strict replay`);
      }
    }
    assert.deepEqual(
      await cleanSource(),
      source,
      "source changed during campaign",
    );
    assert.equal(
      digest(await readFile(jar)),
      artifactSha256,
      "prepared host changed",
    );
    assert.equal(rows.length, 12);
  } catch (error) {
    failure = String(error);
  }
  const summary = {
    format: "timeline-static-campaign/v1",
    source,
    artifactSha256,
    runtimeSha256,
    complete: failure === undefined && rows.length === 12,
    scenarioExecutions,
    attemptedExecutions,
    expectedExecutions: 24,
    rows,
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
  const [
    output,
    jar = "../zooglass/simulation-host/target/zooglass-simulation.jar",
    ...extra
  ] = process.argv.slice(2);
  assert.ok(
    output && !extra.length,
    "Usage: static-campaign NEW_DIRECTORY [PREPARED_JAR]",
  );
  await runStaticCampaign(output, jar);
}
