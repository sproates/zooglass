import assert from "node:assert/strict";
import test from "node:test";
import { runDriver } from "../src/benchmark/driver.js";
import { baseline } from "../src/benchmark/workload.js";

for (const storage of ["memory", "sqlite"] as const) {
  test(
    `benchmark driver checks real ${storage} receipts, live values and final snapshot`,
    { timeout: 30000 },
    async () => {
      const result = await runDriver({
        workload: { ...baseline, storage, residentEntities: 1, hotEntities: 1 },
        rate: 10,
        warmupMs: 100,
        measurementMs: 1000,
        drainMs: 3000,
      });
      assert.equal(result.report.status, "completed", result.report.error);
      assert.equal(result.report.finalSnapshots, 1);
      assert.equal(result.report.accounting.phases.seed.submitted, 64);
      const cohort = result.report.accounting.phases.measurement;
      assert.ok(cohort.submitted > 0);
      assert.equal(cohort.acknowledged, cohort.submitted);
      assert.equal(cohort.validUpdates, cohort.submitted);
      assert.equal(result.report.windows[1].planned, 10);
      assert.equal(result.report.windows[1].notOffered + cohort.submitted, 10);
      assert.equal(result.report.capacityAssessment, "not-run");
      const observations = [...result.observations]
        .map((chunk) => chunk.toString())
        .join("");
      assert.ok(observations.includes('"measurement"'));
    },
  );
}
