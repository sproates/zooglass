import assert from "node:assert/strict";
import test from "node:test";
import { runDriver } from "../src/benchmark/driver.js";
import { startResources } from "../src/benchmark/resources.js";
import { measure } from "../src/benchmark/metrics.js";
import { baseline } from "../src/benchmark/workload.js";

for (const storage of ["memory", "sqlite"] as const) {
  test(
    `benchmark driver checks real ${storage} receipts, live values and final snapshot`,
    { timeout: 30000 },
    async () => {
      const boundaries: string[] = [];
      let sampler: ReturnType<typeof startResources> | undefined;
      const result = await runDriver({
        workload: {
          ...baseline,
          storage,
          residentEntities: 1,
          hotEntities: 1,
          views: 2,
          viewers: 2,
        },
        onReady(pid) {
          sampler = startResources(pid);
        },
        async onBoundary(phase) {
          boundaries.push(phase);
        },
        rate: 10,
        warmupMs: 100,
        measurementMs: 1000,
        drainMs: 3000,
      });
      const samples = await sampler!.stop();
      assert.ok(samples.length > 0);
      assert.equal(result.report.status, "completed", result.report.error);
      assert.equal(result.report.finalSnapshots, 2);
      assert.equal(result.report.accounting.phases.seed.submitted, 64);
      const cohort = result.report.accounting.phases.measurement;
      assert.ok(cohort.submitted > 0);
      assert.equal(cohort.acknowledged, cohort.submitted);
      assert.equal(cohort.validUpdates, cohort.submitted * 4);
      assert.equal(result.report.windows[1].planned, 10);
      assert.equal(result.report.windows[1].notOffered + cohort.submitted, 10);
      assert.equal(result.report.capacityAssessment, "not-run");
      const observations = [...result.observations]
        .map((chunk) => chunk.toString())
        .join("");
      const measured = await measure(
        result.report,
        observations
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)),
      );
      assert.equal(measured.latency.fanoutFromPlan.samples, cohort.submitted);
      assert.equal(
        measured.latency.updateFromPlan.samples,
        cohort.submitted * 4,
      );
      assert.ok(result.report.wireBytes.receivedViewFrames > 0);
      assert.ok(
        result.report.wireBytes.sentEnvelopes >
          result.report.wireBytes.envelopes * 256,
      );
      assert.deepEqual(boundaries, [
        "before-warmup",
        "measurement-start",
        "measurement-end",
      ]);
      assert.ok(observations.includes('"measurement"'));
    },
  );
}
