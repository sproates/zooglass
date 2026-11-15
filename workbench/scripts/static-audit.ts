/** Offline audit of retained outputs. Never runs ZooGlass or trusts summary success alone. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { DocumentRun } from "../src/timeline/campaign-checks.js";
import { baselineMode, perturbedMode } from "./static-campaign.js";
import { checkStaticRun } from "./static-campaign-checks.js";
import { checkStaticSelectionControl } from "./static-selection-control.js";
import { digest, staticCases, writeEvidence } from "./static-evidence.js";

import {
  checkStaticServiceEvidence,
  staticParityPlan,
  staticParityCases,
} from "./static-service-observations.js";
import { parseTimelineDocument } from "../src/timeline/contract.js";
import { validateConversionProvenance } from "../src/timeline/conversion-provenance.js";

const json = async (path: string) => JSON.parse(await readFile(path, "utf8"));
export async function auditStaticCampaign(directory: string) {
  const summary = await json(join(directory, "summary.json"));
  assert.equal(summary.format, "timeline-static-campaign/v1");
  assert.equal(summary.complete, true);
  assert.equal(summary.scenarioExecutions, 24);
  assert.equal(summary.attemptedExecutions, 24);
  assert.equal(summary.expectedExecutions, 24);
  assert.equal(summary.rows.length, 12);
  for (const file of summary.source.files.filter((file: { path: string }) =>
    file.path.startsWith("scenarios/timeline-static/"),
  )) {
    const retained = file.path.slice("scenarios/timeline-static/".length);
    assert.ok(
      retained &&
        !retained.includes("\\") &&
        retained
          .split("/")
          .every((part: string) => part && part !== "." && part !== ".."),
      "unsafe retained fixture path",
    );
    assert.equal(
      digest(await readFile(join(directory, "inputs", retained))),
      file.sha256,
      "retained fixture changed",
    );
  }
  let assertions = 0,
    records = 0,
    nodePauses = 0,
    jvmPauses = 0;
  for (const [index, name] of staticCases.entries()) {
    const scenario = await readFile(
      join(directory, "inputs", name, "scenario.json"),
      "utf8",
    );
    let baseline: DocumentRun | undefined;
    for (const [modeIndex, label] of ["baseline", "perturbed"].entries()) {
      const file = `${name}-${label}.json`,
        replayFile = `${name}-${label}-replay.json`;
      const raw = await readFile(join(directory, file)),
        replayRaw = await readFile(join(directory, replayFile));
      const run: DocumentRun = JSON.parse(raw.toString());
      const replay = JSON.parse(replayRaw.toString());
      const configuration = JSON.parse(scenario).runtime.configuration;
      assert.ok(
        configuration === "configuration.json" ||
          configuration === "runtime.json",
      );
      assert.equal(
        run.configuration,
        await readFile(join(directory, "inputs", name, configuration), "utf8"),
      );
      if (run.conversionProvenance) {
        assert.equal(
          run.conversionProvenance.legacy,
          await readFile(
            join(directory, "inputs", name, "legacy.json"),
            "utf8",
          ),
        );
        assert.equal(
          run.conversionProvenance.report,
          await readFile(
            join(directory, "inputs", name, "conversion-report.json"),
            "utf8",
          ),
        );
      }
      const mode = modeIndex === 0 ? baselineMode : perturbedMode;
      const counts = checkStaticRun(run, scenario, baseline, mode);
      if (!baseline) baseline = run;
      assert.equal(run.execution.artifactSha256, summary.artifactSha256);
      assert.equal(
        run.execution.workbenchSha256,
        summary.source.workbenchSha256,
      );
      assert.deepEqual(summary.rows[index * 2 + modeIndex], {
        name,
        mode: label,
        options: mode,
        file,
        sha256: digest(raw),
        replayFile,
        replaySha256: digest(replayRaw),
        traceSha256: digest(run.trace),
        ...counts,
      });
      assert.equal(replay.status, "verified");
      assert.equal(replay.recordedOutcome, "passed");
      assert.equal(replay.matchedRecords, counts.records);
      checkStaticRun(replay.actual, scenario, run, baselineMode);
      assertions += counts.assertions;
      records += counts.records;
      nodePauses += counts.nodePauses;
      jvmPauses += counts.jvmPauses;
    }
  }
  return {
    source: summary.source,
    runtimeSha256: summary.runtimeSha256,
    executions: 24,
    assertions,
    records,
    nodePauses,
    jvmPauses,
  };
}

export async function auditStaticControl(directory: string) {
  const summary = await json(join(directory, "summary.json"));
  const preparation = await readFile(join(directory, "preparation.json"));
  const prepared = JSON.parse(preparation.toString());
  const normal: DocumentRun = await json(join(directory, "normal.json"));
  const mutant: DocumentRun = await json(join(directory, "mutant.json"));
  assert.equal(summary.format, "timeline-static-selection-control/v1");
  assert.equal(summary.complete, true);
  assert.equal(summary.scenarioExecutions, 2);
  assert.equal(summary.preparationSha256, digest(preparation));
  assert.equal(summary.preparationRevision, prepared.revision);
  assert.deepEqual(summary.artifacts, prepared.artifacts);
  assert.equal(normal.execution.artifactSha256, summary.artifacts.normal);
  assert.equal(mutant.execution.artifactSha256, summary.artifacts.mutant);
  assert.equal(
    normal.execution.workbenchSha256,
    summary.source.workbenchSha256,
  );
  assert.equal(
    digest(await readFile(join(directory, "strategy-original.java"))),
    prepared.mutation.originalSha256,
  );
  assert.equal(
    digest(await readFile(join(directory, "strategy-mutant.java"))),
    prepared.mutation.mutatedSha256,
  );
  const original = await readFile(
    join(directory, "strategy-original.java"),
    "utf8",
  );
  assert.equal(original.split(prepared.mutation.before).length, 2);
  assert.equal(
    await readFile(join(directory, "strategy-mutant.java"), "utf8"),
    original.replace(prepared.mutation.before, prepared.mutation.after),
  );
  assert.equal(
    normal.configuration,
    await readFile(join(directory, "runtime.json"), "utf8"),
  );
  for (const file of ["scenario.json", "runtime.json", "ORACLE.md"]) {
    const identity = summary.source.files.find(
      (item: { path: string }) =>
        item.path === `scenarios/timeline-static/mixed-modes/${file}`,
    );
    assert.ok(identity, "retained control input identity missing");
    assert.equal(
      digest(await readFile(join(directory, file))),
      identity.sha256,
    );
  }
  const details = checkStaticSelectionControl(normal, mutant);
  assert.deepEqual(summary.details, details);
  checkStaticRun(
    normal,
    await readFile(join(directory, "scenario.json"), "utf8"),
    undefined,
    baselineMode,
  );
  return { source: summary.source, executions: 2, ...details };
}

export async function auditStaticEvidence(directory: string) {
  const campaign = await auditStaticCampaign(join(directory, "campaign"));
  const control = await auditStaticControl(join(directory, "control"));
  assert.deepEqual(campaign.source, control.source);
  const service = [];
  for (const name of staticParityCases) {
    const folder = join(directory, `service-${name}`);
    const evidence = await json(join(folder, "evidence.json"));
    const scenario = await readFile(join(folder, "scenario.json"), "utf8");
    const configurationName =
      name === "mixed-modes" ? "runtime.json" : "configuration.json";
    const configuration = await readFile(
      join(folder, configurationName),
      "utf8",
    );
    const counts = checkStaticServiceEvidence(
      evidence,
      scenario,
      configuration,
    );
    assert.equal(evidence.case, name);
    assert.equal(evidence.revision, campaign.source.revision);
    assert.equal(
      evidence.provenanceBefore.workbench,
      campaign.source.workbenchSha256,
    );
    assert.equal(
      scenario,
      await readFile(
        join(directory, "campaign/inputs", name, "scenario.json"),
        "utf8",
      ),
    );
    assert.equal(
      configuration,
      await readFile(
        join(directory, "campaign/inputs", name, configurationName),
        "utf8",
      ),
    );
    assert.deepEqual(
      await json(join(folder, "inputs.json")),
      staticParityPlan(scenario, configuration),
    );
    if (name === "late-update") {
      const legacy = await readFile(join(folder, "legacy.json"), "utf8");
      const report = await readFile(
        join(folder, "conversion-report.json"),
        "utf8",
      );
      assert.equal(digest(legacy), evidence.provenanceBefore.legacy);
      assert.equal(digest(report), evidence.provenanceBefore.conversionReport);
      validateConversionProvenance(
        parseTimelineDocument(scenario),
        configuration,
        { legacy, report },
      );
    }
    service.push({
      case: name,
      executions: 1,
      ...counts,
      artifactSha256: evidence.provenanceBefore.service,
      coreSha256: evidence.provenanceBefore.core,
    });
  }
  assert.equal(service[0].artifactSha256, service[1].artifactSha256);
  assert.equal(service[0].coreSha256, service[1].coreSha256);
  assert.equal(
    service[0].coreSha256,
    campaign.runtimeSha256,
    "service and timeline use identical production runtime artifact",
  );
  return {
    format: "timeline-static-audit/v1",
    complete: true,
    scenarioExecutions: 28,
    campaign,
    control,
    service,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [directory, output, ...extra] = process.argv.slice(2);
  assert.ok(
    directory && output && !extra.length,
    "Usage: static-audit EVIDENCE_DIRECTORY NEW_REPORT",
  );
  await writeEvidence(output, await auditStaticEvidence(directory));
}
