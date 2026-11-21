/** Fixed 12-execution qualification. Preparation is separate and never called here. */
import assert from "node:assert/strict";
import { cp, mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { recordBundle } from "../src/timeline/artifact-bundle.js";
import { parseReplay, replaySaved } from "../src/timeline/replay-document.js";
import type { DocumentRun } from "../src/timeline/campaign-checks.js";
import { explainBundle, writeExplanation } from "../src/explanation/reader.js";
import {
  checkExplanationCase,
  checkReasonMutant,
  checkExplanationPauses,
  type ExplanationCase,
} from "./explanation-checks.js";
import {
  explanationSource,
  explanationInventory,
  digest,
  workbench,
  writeEvidence,
} from "./explanation-evidence.js";
import { readExplanationPreparation } from "./explanation-preparation.js";
import { auditExplanationSafety } from "./explanation-safety.js";

export async function runExplanationCampaign(
  output: string,
  preparation: string,
) {
  const source = await explanationSource();
  const prepared = await readExplanationPreparation(resolve(preparation));
  assert.equal(
    prepared.provenance.javaSourceTree,
    source.javaSourceTree,
    "prepared production source differs from campaign",
  );
  const directory = resolve(output);
  await mkdir(directory);
  await cp(
    join(workbench, "scenarios/timeline-explanations"),
    join(directory, "inputs"),
    { recursive: true, force: false, errorOnExist: true },
  );
  await writeEvidence(join(directory, "preparation.json"), {
    provenance: prepared.provenance,
    inventories: prepared.inventories,
    original: prepared.original.toString(),
    mutated: prepared.mutated.toString(),
  });
  const rows: {
    name: string;
    case: ExplanationCase;
    check: ReturnType<typeof checkExplanationCase>;
  }[] = [];
  const replays: string[] = [];
  let executions = 0;
  let baseline: DocumentRun | undefined;
  let control: ReturnType<typeof checkReasonMutant> | undefined;
  let safety: Awaited<ReturnType<typeof auditExplanationSafety>> | undefined;
  let failure: string | undefined;
  const run = async (
    name: ExplanationCase,
    label: string,
    mutant = false,
    paused = false,
  ) => {
    executions++;
    const bundle = join(directory, label);
    const result = await recordBundle(
      join(directory, "inputs", name, "scenario.json"),
      bundle,
      {
        jar: prepared.artifacts[mutant ? "mutant" : "normal"],
        ...(paused ? { jvmPauseMs: 70, hostDelay: 70 } : {}),
      },
    );
    const report = await explainBundle(bundle);
    await writeExplanation(bundle, join(directory, `${label}.txt`), "text");
    await writeExplanation(bundle, join(directory, `${label}.json`), "json");
    return { result, report };
  };
  try {
    for (const name of ["memory", "sqlite"] as const) {
      let normal: DocumentRun | undefined;
      for (const mode of ["baseline", "paused"] as const) {
        const label = `${name}-${mode}`;
        const { result, report } = await run(
          name,
          label,
          false,
          mode === "paused",
        );
        rows.push({
          name: label,
          case: name,
          check: checkExplanationCase(name, result, report),
        });
        if (normal) checkExplanationPauses(normal, result);
        else normal = result;
        if (name === "memory" && mode === "baseline") baseline = result;
        executions++;
        const replay = await replaySaved(parseReplay(JSON.stringify(result)), {
          jar: prepared.artifacts.normal,
        });
        await writeEvidence(join(directory, `${label}-replay.json`), replay);
        assert.equal(replay.status, "verified");
        assert.equal(replay.recordedOutcome, "passed");
        checkExplanationCase(name, replay.actual, report);
        replays.push(label);
        console.log(`Verified ${label} and strict replay`);
      }
    }
    for (const name of ["rejected", "assertion-failure", "legacy"] as const) {
      const { result, report } = await run(name, name);
      rows.push({
        name,
        case: name,
        check: checkExplanationCase(name, result, report),
      });
    }
    const mutant = await run("memory", "reason-mutant", true);
    control = checkReasonMutant(baseline!, mutant.result, mutant.report);
    safety = await auditExplanationSafety(
      join(directory, "memory-baseline"),
      join(directory, "safety-scratch"),
    );
    assert.deepEqual(
      await explanationSource(),
      source,
      "source changed during qualification",
    );
    assert.equal(
      digest(await readFile(prepared.artifacts.normal)),
      prepared.provenance.artifacts.normal,
    );
    assert.equal(
      digest(await readFile(prepared.artifacts.mutant)),
      prepared.provenance.artifacts.mutant,
    );
    assert.equal(executions, 12);
  } catch (error) {
    failure = String(error);
  }
  const summary = {
    format: "timeline-explanation-qualification/v1",
    source,
    complete: failure === undefined,
    executions,
    expectedExecutions: 12,
    rows,
    replays,
    control,
    safety,
    files: await explanationInventory(directory),
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
  const [output, preparation, ...extra] = process.argv.slice(2);
  assert.ok(
    output && preparation && !extra.length,
    "Usage: explanation-campaign NEW_DIRECTORY PREPARATION_DIRECTORY",
  );
  await runExplanationCampaign(output, preparation);
}
