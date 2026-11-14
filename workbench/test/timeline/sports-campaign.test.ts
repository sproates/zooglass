import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  checkSportsCampaignRun,
  sportsCounts,
} from "../../scripts/sports-campaign-checks.js";
import { runDocument } from "../../src/timeline/run-document.js";
import type { DocumentRun } from "../../src/timeline/campaign-checks.js";
const jar = resolve(
  process.env.ZOOGLASS_SIMULATION_JAR ??
    "../zooglass/simulation-host/target/zooglass-simulation.jar",
);
const baselineMode = {
  hostDelay: 0,
  paced: false,
  idlePauseMs: 0,
  jvmPauseMs: 0,
};
const mode = { hostDelay: 70, paced: true, idlePauseMs: 70, jvmPauseMs: 90 };
test("Sports campaign checks complete authored outcomes in both fixed groups", async (t) => {
  const diagnosticDirectory = await mkdtemp(join(tmpdir(), "sports-campaign-"));
  t.after(() => rm(diagnosticDirectory, { recursive: true, force: true }));
  for (const expected of sportsCounts) {
    const path = resolve(
      `scenarios/timeline-sports${expected.group === "retention" ? "-retention" : ""}/scenario.json`,
    );
    const run = await runDocument(path, { jar, diagnosticDirectory });
    checkSportsCampaignRun(
      JSON.stringify(run),
      undefined,
      baselineMode,
      expected,
    );
    assert.throws(() =>
      checkSportsCampaignRun(
        JSON.stringify({ ...run, outcome: "assertion-failed" }),
        undefined,
        baselineMode,
        expected,
      ),
    );
    const lines = run.trace
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    const assertion = lines.find((row) => row.kind === "assertion");
    assertion.data.expected = [];
    assertion.data.actual = [];
    assert.throws(() =>
      checkSportsCampaignRun(
        JSON.stringify({
          ...run,
          trace: lines.map((row) => JSON.stringify(row)).join("\n") + "\n",
        }),
        undefined,
        baselineMode,
        expected,
      ),
    );
  }
});
test("Sports campaign requires measured pauses and rejects evidence omissions and divergence", async (t) => {
  const diagnosticDirectory = await mkdtemp(join(tmpdir(), "sports-pauses-"));
  t.after(() => rm(diagnosticDirectory, { recursive: true, force: true }));
  const expected = sportsCounts[1];
  const path = resolve("scenarios/timeline-sports-retention/scenario.json");
  const run = await runDocument(path, { jar, diagnosticDirectory, ...mode });
  checkSportsCampaignRun(JSON.stringify(run), undefined, mode, expected);
  for (const mutate of [
    (copy: DocumentRun) => {
      copy.diagnostics.generations![0].jvm!.pauses = [];
    },
    (copy: DocumentRun) => {
      copy.diagnostics.generations![0].jvm!.pauses[0].elapsedNanos = 1;
    },
    (copy: DocumentRun) => {
      copy.diagnostics.generations![0].jvm!.pauses[0].virtualMs = 11;
    },
    (copy: DocumentRun) => {
      copy.diagnostics.generations![0].node.pop();
    },
    (copy: DocumentRun) => {
      copy.diagnostics.generations![0].node[0].elapsedNanos = 49_000_000;
    },
  ]) {
    const copy = structuredClone(run);
    mutate(copy);
    assert.throws(() =>
      checkSportsCampaignRun(JSON.stringify(copy), undefined, mode, expected),
    );
  }
  assert.throws(
    () =>
      checkSportsCampaignRun(
        JSON.stringify(run),
        { ...run, trace: run.trace + "\n" },
        mode,
        expected,
      ),
    /semantic trace divergence/,
  );
  assert.throws(
    () =>
      checkSportsCampaignRun(JSON.stringify(run), undefined, mode, {
        ...expected,
        commands: 114,
      }),
    /Node command pauses/,
  );
});
