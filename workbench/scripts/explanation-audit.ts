/** Offline re-check of the fixed qualification, never launches Java. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readBundle } from "../src/timeline/artifact-bundle.js";
import { parseReplay } from "../src/timeline/replay-document.js";
import type { DocumentRun } from "../src/timeline/campaign-checks.js";
import { explainBundle } from "../src/explanation/reader.js";
import { renderExplanation } from "../src/explanation/render.js";
import { parseTimelineDocument } from "../src/timeline/contract.js";
import {
  checkExplanationCase,
  checkReasonMutant,
  checkExplanationPauses,
  type ExplanationCase,
} from "./explanation-checks.js";
import {
  explanationInventory,
  readExplanationJson as readJson,
  digest,
  writeEvidence,
} from "./explanation-evidence.js";
import {
  mutateExplanationReason,
  verifyExplanationInventories,
  type ExplanationPreparation,
} from "./explanation-preparation.js";
import { auditExplanationSafety } from "./explanation-safety.js";
import {
  includeRecoveryEnvironment,
  type RecoveryEnvironment,
} from "./recovery-environment.js";
import type { runExplanationCampaign } from "./explanation-campaign.js";

export async function auditExplanationCampaign(directory: string) {
  const summary = await readJson<
    Awaited<ReturnType<typeof runExplanationCampaign>>
  >(join(directory, "summary.json"));
  assert.equal(summary.format, "timeline-explanation-qualification/v1");
  assert.equal(summary.complete, true);
  assert.equal(summary.executions, 12);
  assert.equal(summary.expectedExecutions, 12);
  assert.deepEqual(await explanationInventory(directory), summary.files);
  const preparation = await readJson<{
    provenance: ExplanationPreparation;
    original: string;
    mutated: string;
    inventories: {
      hosts: [string, string][][];
      runtimes: [string, string][][];
    };
  }>(join(directory, "preparation.json"));
  assert.equal(
    preparation.provenance.javaSourceTree,
    summary.source.javaSourceTree,
  );
  assert.equal(
    mutateExplanationReason(preparation.original),
    preparation.mutated,
  );
  assert.equal(
    digest(preparation.original),
    preparation.provenance.mutation.originalSha256,
  );
  assert.equal(
    digest(preparation.mutated),
    preparation.provenance.mutation.mutatedSha256,
  );
  verifyExplanationInventories(
    new Map(preparation.inventories.hosts[0]),
    new Map(preparation.inventories.hosts[1]),
    new Map(preparation.inventories.runtimes[0]),
    new Map(preparation.inventories.runtimes[1]),
    preparation.provenance,
  );
  const runs = new Map<string, DocumentRun>();
  const rows = [];
  const replays = [];
  let environment: RecoveryEnvironment | undefined;
  let pauseCount = 0;
  const labels: [string, ExplanationCase][] = [
    ["memory-baseline", "memory"],
    ["memory-paused", "memory"],
    ["sqlite-baseline", "sqlite"],
    ["sqlite-paused", "sqlite"],
    ["rejected", "rejected"],
    ["assertion-failure", "assertion-failure"],
    ["legacy", "legacy"],
    ["reason-mutant", "memory"],
  ];
  for (const [label, name] of labels) {
    const bundle = join(directory, label);
    const saved = await readBundle(bundle);
    const run = await readJson<DocumentRun>(join(bundle, "run.json"));
    assert.equal(
      run.execution.artifactSha256,
      preparation.provenance.artifacts[
        label === "reason-mutant" ? "mutant" : "normal"
      ],
    );
    assert.equal(run.execution.workbenchSha256, summary.source.workbenchSha256);
    for (const file of ["scenario.json", "runtime.json"]) {
      const path = `scenarios/timeline-explanations/${name}/${file}`;
      const source = summary.source.files.filter(
        (entry) => entry.path === path,
      );
      assert.equal(source.length, 1);
      const input = await readFile(
        join(directory, "inputs", name, file),
        "utf8",
      );
      assert.equal(digest(input), source[0].sha256);
      assert.equal(
        file === "scenario.json"
          ? parseTimelineDocument(input).canonical
          : input,
        file === "scenario.json" ? run.scenario : run.configuration,
      );
    }
    environment = includeRecoveryEnvironment(
      environment,
      run.environment,
      saved.scenario.storage,
    );
    const report = await explainBundle(bundle);
    for (const format of ["text", "json"] as const)
      assert.equal(
        await readFile(
          join(directory, `${label}.${format === "text" ? "txt" : "json"}`),
          "utf8",
        ),
        renderExplanation(report, format),
      );
    runs.set(label, run);
    if (label === "reason-mutant") {
      assert.deepEqual(
        checkReasonMutant(runs.get("memory-baseline")!, run, report),
        summary.control,
      );
      continue;
    }
    rows.push({
      name: label,
      case: name,
      check: checkExplanationCase(name, run, report),
    });
    if (label.endsWith("paused"))
      pauseCount += checkExplanationPauses(runs.get(`${name}-baseline`)!, run);
    if (label.endsWith("baseline") || label.endsWith("paused")) {
      const replay = await readJson<{
        status: string;
        recordedOutcome: string;
        actual: DocumentRun;
      }>(join(directory, `${label}-replay.json`));
      assert.equal(replay.status, "verified");
      assert.equal(replay.recordedOutcome, "passed");
      parseReplay(JSON.stringify(replay.actual));
      assert.equal(replay.actual.trace, run.trace);
      assert.deepEqual(replay.actual.execution, run.execution);
      assert.deepEqual(replay.actual.environment, run.environment);
      checkExplanationCase(name, replay.actual, report);
      replays.push(label);
    }
  }
  assert.deepEqual(rows, summary.rows);
  assert.deepEqual(replays, summary.replays);
  const safety = await auditExplanationSafety(
    join(directory, "memory-baseline"),
    join(directory, "audit-scratch"),
  );
  assert.deepEqual(safety, summary.safety);
  return {
    format: "timeline-explanation-audit/v1",
    verified: true,
    executions: 12,
    replays: replays.length,
    jvmPauses: pauseCount,
    cases: rows.length,
    safety,
    sourceRevision: summary.source.revision,
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [directory, output, ...extra] = process.argv.slice(2);
  assert.ok(
    directory && output && !extra.length,
    "Usage: explanation-audit DIRECTORY NEW_REPORT",
  );
  const audit = await auditExplanationCampaign(resolve(directory));
  await writeEvidence(resolve(output), audit);
  console.log("Verified fixed 12-execution explanation qualification");
}
