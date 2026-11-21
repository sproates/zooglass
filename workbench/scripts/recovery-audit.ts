/** Offline audit of retained outputs. Never runs ZooGlass or trusts summary success alone. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { DocumentRun } from "../src/timeline/campaign-checks.js";
import { baselineMode, perturbedMode } from "./recovery-campaign.js";
import { checkRecoveryRun } from "./recovery-campaign-checks.js";
import { checkRecoveryControl } from "./recovery-control.js";
import { digest, recoveryCases, writeEvidence } from "./recovery-evidence.js";

const json = async (path: string) => JSON.parse(await readFile(path, "utf8"));
export async function auditRecoveryCampaign(directory: string) {
  const summary = await json(join(directory, "summary.json"));
  assert.equal(summary.format, "timeline-static-recovery-campaign/v1");
  assert.equal(summary.complete, true);
  assert.equal(summary.scenarioExecutions, 24);
  assert.equal(summary.attemptedExecutions, 24);
  assert.equal(summary.expectedExecutions, 24);
  assert.equal(summary.rows.length, 12);
  for (const name of recoveryCases)
    for (const file of ["scenario.json", "runtime.json"])
      assert.equal(
        summary.source.files.filter(
          (entry: { path: string }) =>
            entry.path === `scenarios/timeline-static-recovery/${name}/${file}`,
        ).length,
        1,
        "complete input identity inventory",
      );
  for (const file of summary.source.files.filter((file: { path: string }) =>
    file.path.startsWith("scenarios/timeline-static-recovery/"),
  )) {
    const retained = file.path.slice(
      "scenarios/timeline-static-recovery/".length,
    );
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
  let environment: DocumentRun["environment"] | undefined;
  let assertions = 0,
    records = 0,
    nodePauses = 0,
    jvmPauses = 0;
  for (const [index, name] of recoveryCases.entries()) {
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
      if (environment)
        assert.deepEqual(
          run.environment,
          environment,
          "campaign environment drift",
        );
      else environment = run.environment;
      const replay = JSON.parse(replayRaw.toString());
      const configuration = JSON.parse(scenario).runtime.configuration;
      assert.ok(configuration === "runtime.json");
      assert.equal(
        run.configuration,
        await readFile(join(directory, "inputs", name, configuration), "utf8"),
      );
      const mode = modeIndex === 0 ? baselineMode : perturbedMode;
      const counts = checkRecoveryRun(name, run, scenario, baseline, mode);
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
      checkRecoveryRun(name, replay.actual, scenario, run, baselineMode);
      assertions += counts.assertions;
      records += counts.records;
      nodePauses += counts.nodePauses;
      jvmPauses += counts.jvmPauses;
    }
  }
  return {
    source: summary.source,
    artifactSha256: summary.artifactSha256,
    environment,
    runtimeSha256: summary.runtimeSha256,
    executions: 24,
    assertions,
    records,
    nodePauses,
    jvmPauses,
  };
}

import {
  recoveryMutation,
  verifyRecoveryInventories,
} from "./recovery-preparation.js";
import {
  checkRecoveryServiceEvidence,
  recoveryServicePlan,
} from "./recovery-service-observations.js";

export async function auditRecoveryControl(directory: string) {
  const summary = await json(join(directory, "summary.json"));
  const preparation = await readFile(join(directory, "preparation.json"));
  const prepared = JSON.parse(preparation.toString());
  const normal: DocumentRun = await json(join(directory, "normal.json"));
  const mutant: DocumentRun = await json(join(directory, "mutant.json"));
  assert.equal(summary.format, "timeline-static-recovery-control/v1");
  assert.equal(prepared.format, "timeline-static-recovery-preparation/v1");
  assert.equal(summary.complete, true);
  assert.equal(summary.scenarioExecutions, 2);
  assert.equal(summary.preparationSha256, digest(preparation));
  assert.equal(summary.preparationRevision, prepared.revision);
  assert.deepEqual(summary.artifacts, prepared.artifacts);
  assert.equal(normal.execution.artifactSha256, prepared.artifacts.normal);
  assert.equal(mutant.execution.artifactSha256, prepared.artifacts.mutant);
  assert.equal(
    normal.execution.workbenchSha256,
    summary.source.workbenchSha256,
  );
  const original = await readFile(
    join(directory, "recovery-original.java"),
    "utf8",
  );
  const mutated = await readFile(
    join(directory, "recovery-mutant.java"),
    "utf8",
  );
  assert.equal(original.split(recoveryMutation.before).length, 2);
  assert.equal(
    mutated,
    original.replace(recoveryMutation.before, recoveryMutation.after),
  );
  assert.deepEqual(prepared.mutation, {
    ...recoveryMutation,
    originalSha256: digest(original),
    mutatedSha256: digest(mutated),
    originalClassSha256: prepared.mutation.originalClassSha256,
    mutatedClassSha256: prepared.mutation.mutatedClassSha256,
  });
  const inventories = await json(join(directory, "inventories.json"));
  verifyRecoveryInventories(
    new Map(inventories.hosts[0]),
    new Map(inventories.hosts[1]),
    new Map(inventories.runtimes[0]),
    new Map(inventories.runtimes[1]),
    prepared,
  );
  for (const [file, hash] of [
    ["prepare-static-recovery-mutation.py", prepared.recipeSha256],
    ["prepare-generation-clock-mutation.py", prepared.helperSha256],
  ]) {
    assert.equal(digest(await readFile(join(directory, file))), hash);
    assert.equal(
      summary.source.files.find(
        (entry: { path: string }) => entry.path === `scripts/${file}`,
      )?.sha256,
      hash,
    );
  }
  for (const file of ["scenario.json", "runtime.json"]) {
    const identity = summary.source.files.find(
      (entry: { path: string }) =>
        entry.path === `scenarios/timeline-static-recovery/s1/${file}`,
    );
    assert.ok(identity, "retained control input identity missing");
    assert.equal(
      digest(await readFile(join(directory, file))),
      identity.sha256,
    );
  }
  assert.equal(
    normal.configuration,
    await readFile(join(directory, "runtime.json"), "utf8"),
  );
  const details = checkRecoveryControl(normal, mutant);
  assert.deepEqual(summary.details, details);
  checkRecoveryRun(
    "s1",
    normal,
    await readFile(join(directory, "scenario.json"), "utf8"),
    undefined,
    baselineMode,
  );
  return {
    source: summary.source,
    artifactSha256: prepared.artifacts.normal,
    environment: normal.environment,
    runtimeSha256: prepared.runtime.normal,
    executions: 2,
    ...details,
  };
}

export async function auditRecoveryEvidence(directory: string) {
  const campaign = await auditRecoveryCampaign(join(directory, "campaign"));
  const control = await auditRecoveryControl(join(directory, "control"));
  assert.deepEqual(control.source, campaign.source);
  assert.equal(control.runtimeSha256, campaign.runtimeSha256);
  assert.equal(
    control.artifactSha256,
    campaign.artifactSha256,
    "campaign must use the prepared normal host",
  );
  assert.deepEqual(
    control.environment,
    campaign.environment,
    "control/campaign environment drift",
  );
  const service = [];
  for (const name of ["m1", "s1"] as const) {
    const folder = join(directory, `service-${name}`);
    const evidence = await json(join(folder, "evidence.json"));
    const scenario = await readFile(join(folder, "scenario.json"), "utf8");
    const configuration = await readFile(join(folder, "runtime.json"), "utf8");
    const counts = checkRecoveryServiceEvidence(
      evidence,
      scenario,
      configuration,
    );
    assert.equal(evidence.case, name);
    assert.deepEqual(evidence.source, campaign.source);
    for (const field of ["node", "platform", "arch"] as const)
      assert.equal(
        evidence.environment[field],
        campaign.environment![field],
        `service ${field} drift`,
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
        join(directory, "campaign/inputs", name, "runtime.json"),
        "utf8",
      ),
    );
    assert.deepEqual(
      await json(join(folder, "plan.json")),
      recoveryServicePlan(name, scenario, configuration),
    );
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
    "ordinary service and timeline production runtime differ",
  );
  return {
    format: "timeline-static-recovery-audit/v1",
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
    "Usage: recovery-audit EVIDENCE_DIRECTORY NEW_REPORT",
  );
  await writeEvidence(output, await auditRecoveryEvidence(directory));
}
