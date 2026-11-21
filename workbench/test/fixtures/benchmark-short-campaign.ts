import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { openCampaign } from "../../src/benchmark/campaign/journal.js";
import {
  campaignLimits,
  type CampaignManifest,
  type VerifyResult,
} from "../../src/benchmark/campaign/model.js";
import { runDriver } from "../../src/benchmark/driver.js";
import { baseline } from "../../src/benchmark/workload.js";
import { nextSlot } from "../../src/benchmark/campaign/plan.js";

// Short store/phase fixtures exercise checkpoints and process ownership; production
// campaign durations and pass budgets remain fixed in the public command.
const [directory, mode] = process.argv.slice(2);
if (mode !== "create" && mode !== "resume")
  throw new Error("Invalid fixture mode");
const manifest: CampaignManifest = {
  format: "benchmark-campaign/v1",
  campaignId: "short-service-smoke",
  limits: campaignLimits,
  identity: { fixture: "prepared-multiview" },
  selectionRule: "fixture",
  slots: (["memory", "sqlite"] as const).map((storage) => ({
    id: storage,
    storage,
    variant: "baseline",
    replicate: 1,
    baselineRate: 10,
    workload: {
      ...baseline,
      storage,
      hotEntities: 1,
      residentEntities: 1,
      views: 2,
      viewers: 2,
    },
  })),
};
const verifyResult: VerifyResult = async (token, completion) => {
  const result = JSON.parse(
    await readFile(join(token.directory, "result.json"), "utf8"),
  );
  assert.equal(result.status, "completed", result.error);
  assert.equal(result.finalSnapshots, 2);
  const cohort = result.accounting.phases.measurement;
  assert.ok(cohort.submitted > 0);
  assert.equal(cohort.validUpdates, cohort.submitted * 4);
  assert.equal(cohort.acknowledged, cohort.submitted);
  assert.equal(cohort.completedFanout, cohort.submitted);
  assert.equal(completion.outcome, "service-budget"); // short fixture has fewer than 1000 samples
};
const lockFd = Number(process.env.ZOOGLASS_CAMPAIGN_LOCK_FD);
const journal = await openCampaign(directory, {
  mode,
  manifest,
  conditions: { session: mode },
  verifyResult,
  lockFd,
});
try {
  const next = nextSlot(manifest, journal.state, journal.replacements);
  assert.ok(next && next.slot && next.rate);
  assert.equal(next.slot.storage, mode === "create" ? "memory" : "sqlite");
  const token = await journal.reserveAttempt(next.slot.id, next.rate);
  const result = await runDriver({
    workload: token.slot.workload,
    rate: 10,
    warmupMs: 100,
    measurementMs: 500,
    drainMs: 3000,
    inheritedLockFd: lockFd,
  });
  await writeFile(
    join(token.directory, "result.json"),
    JSON.stringify(result.report),
  );
  await journal.finishAttempt(token, {
    outcome: "service-budget",
    reason: "short fixture",
    artifacts: ["result.json"],
  });
} finally {
  await journal.closeSession("one fixture attempt");
}
