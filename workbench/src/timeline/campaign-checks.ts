import assert from "node:assert/strict";
import type { runDocument } from "./run-document.js";
export type DocumentRun = Awaited<ReturnType<typeof runDocument>>;
export type CampaignMode = {
  hostDelay: number;
  paced: boolean;
  idlePauseMs: number;
  jvmPauseMs: number;
};
export type CampaignExpectation = {
  draws: string[];
  losses?: boolean[];
  pauseTimes: Record<string, number>;
};

/** Correctness is decided by literal scenario assertions; equality is a separate requirement. */
export function checkCampaignRun(
  run: DocumentRun,
  baseline: DocumentRun | undefined,
  mode: CampaignMode,
  expected: CampaignExpectation,
) {
  assert.equal(run.outcome, "passed", run.message ?? "scenario failed");
  if (baseline) {
    assert.deepEqual(
      run.execution,
      baseline.execution,
      "execution identity drift",
    );
    assert.deepEqual(
      run.environment,
      baseline.environment,
      "environment drift",
    );
    assert.equal(run.scenario, baseline.scenario, "scenario drift");
    assert.equal(
      run.configuration,
      baseline.configuration,
      "configuration drift",
    );
    assert.equal(run.trace, baseline.trace, "semantic trace divergence");
  }
  const records = run.trace
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    records
      .filter((record) => record.kind === "fault-decision")
      .map((record) => record.data.digest),
    expected.draws,
    "independent draw vectors",
  );
  if (expected.losses)
    assert.deepEqual(
      records
        .filter((record) => record.kind === "fault-decision")
        .map((record) => record.data.lost),
      expected.losses,
      "independent loss sequence",
    );
  const timing = run.diagnostics.jvm;
  assert.ok(timing, "prepared JVM must report timing diagnostics");
  assert.equal(timing.pauseMillis, mode.jvmPauseMs);
  assert.deepEqual(
    {
      hostDelay: run.diagnostics.hostDelayMs,
      paced: run.diagnostics.paced,
      idlePauseMs: run.diagnostics.idlePauseMs,
    },
    {
      hostDelay: mode.hostDelay,
      paced: mode.paced,
      idlePauseMs: mode.idlePauseMs,
    },
  );
  const sites = mode.jvmPauseMs ? Object.keys(expected.pauseTimes).sort() : [];
  assert.deepEqual(
    timing.pauses.map((pause) => pause.site).sort(),
    sites,
    "each requested pause site must fire once",
  );
  for (const pause of timing.pauses) {
    assert.equal(pause.requestedMillis, mode.jvmPauseMs);
    assert.equal(pause.virtualMs, expected.pauseTimes[pause.site]);
    assert.ok(
      Number.isSafeInteger(pause.elapsedNanos) &&
        pause.elapsedNanos >= mode.jvmPauseMs * 1000000,
      "observed host pause duration",
    );
  }
}
