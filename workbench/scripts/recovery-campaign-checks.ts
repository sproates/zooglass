import assert from "node:assert/strict";
import {
  checkCampaignRun,
  type CampaignMode,
  type DocumentRun,
} from "../src/timeline/campaign-checks.js";
import { parseReplay } from "../src/timeline/replay-document.js";
import { canonicalJson } from "../src/timeline/json.js";
import { staticRecoveryProfile } from "../src/timeline/evidence-versions.js";

// Reviewed fixture times, independent of the recorded execution and its diagnostics.
const initial = {
  start: 0,
  state: 10,
  writer: 1,
  ingress: [10, 15, 20, 30, 35],
};
type Generation = {
  start: number;
  state?: number;
  writer: number;
  ingress: readonly number[];
};
export const recoveryWitnesses: Record<string, readonly Generation[]> = {
  m1: [initial, { start: 60, state: 70, writer: 62, ingress: [70] }],
  m2: [initial, { start: 50, state: 70, writer: 52, ingress: [70] }],
  s1: [initial, { start: 60, writer: 62, ingress: [70] }],
  s2: [initial, { start: 60, state: 80, writer: 62, ingress: [70, 80] }],
  s3: [
    initial,
    { start: 60, state: 80, writer: 62, ingress: [70, 80] },
    { start: 100, writer: 102, ingress: [110, 111, 112] },
  ],
  b1: [{ ...initial, ingress: [...initial.ingress, 45] }],
};

/** Check authored observations and pause invariance, including every restarted generation. */
export function checkRecoveryRun(
  name: string,
  run: DocumentRun,
  scenario: string,
  baseline: DocumentRun | undefined,
  mode: CampaignMode,
) {
  const witnesses = recoveryWitnesses[name];
  assert.ok(witnesses, "unknown recovery witness");
  const parsed = parseReplay(JSON.stringify(run));
  assert.equal(parsed.versions.run, "timeline-run/v4");
  assert.equal(run.execution.profile, staticRecoveryProfile);
  assert.equal(
    run.scenario,
    canonicalJson(scenario),
    "retained reviewed scenario",
  );
  const document = JSON.parse(scenario);
  const records = parsed.lines.map((line) => JSON.parse(line));
  const generations = run.diagnostics.generations;
  assert.deepEqual(
    generations?.map((g) => g.runtimeGeneration),
    witnesses.map((_, i) => i + 1),
    "complete ordered runtime generations",
  );
  const starts = records.filter((r) => r.kind === "runtime-initialized");
  assert.equal(starts.length, witnesses.length);
  let nodePauses = 0,
    jvmPauses = 0;
  witnesses.forEach((expected, index) => {
    const generation = generations![index];
    checkCampaignRun(
      { ...run, diagnostics: { ...run.diagnostics, jvm: generation.jvm } },
      baseline,
      mode,
      {
        draws: [],
        pauseTimes: {
          ...(expected.state === undefined
            ? {}
            : { "state-effect": expected.state }),
          "writer-handoff": expected.writer,
        },
      },
    );
    assert.equal(starts[index].runtimeGeneration, index + 1);
    assert.equal(starts[index].key[0], expected.start);
    assert.equal(starts[index].data.monotonicMs, 0);
    assert.equal(
      starts[index].data.wallMillis,
      document.clock.epochMillis + expected.start,
    );
    const pauses = generation.node;
    if (!mode.hostDelay) assert.deepEqual(pauses, []);
    else {
      for (const pause of pauses) {
        assert.equal(pause.requestedMillis, mode.hostDelay);
        assert.ok(
          Number.isSafeInteger(pause.elapsedNanos) &&
            pause.elapsedNanos > 50_000_000,
          "measured Node pause too short",
        );
      }
      for (const [operation, timeMs] of [
        ["initialize-document", expected.start],
        ...expected.ingress.map((time) => ["ingress", time]),
      ])
        assert.ok(
          pauses.some((p) => p.operation === operation && p.timeMs === timeMs),
          `missing generation ${index + 1} Node pause: ${operation}/${timeMs}`,
        );
    }
    nodePauses += pauses.length;
    jvmPauses += generation.jvm!.pauses.length;
  });
  const assertions = records.filter((r) => r.kind === "assertion");
  const expectedAssertions = [...document.assertions].sort(
    (a, b) => a.atMs - b.atMs,
  );
  assert.equal(
    assertions.length,
    expectedAssertions.length,
    "complete authored assertions",
  );
  assertions.forEach((observed, index) => {
    const expected = expectedAssertions[index];
    assert.deepEqual(
      [
        observed.key[0],
        observed.data.assertionId,
        observed.data.assertionKind,
        observed.data.passed,
      ],
      [expected.atMs, expected.id, expected.kind, true],
    );
    if (expected.kind !== "source-accepted") {
      assert.equal(
        canonicalJson(JSON.stringify(observed.data.expected)),
        canonicalJson(JSON.stringify(expected.expected)),
        "retained literal expectation",
      );
      assert.equal(
        canonicalJson(JSON.stringify(observed.data.actual)),
        canonicalJson(JSON.stringify(expected.expected)),
        "independent expected observation",
      );
    }
  });
  const attempts = document.actions.filter((a: { kind: string }) =>
    ["source-send", "source-retry"].includes(a.kind),
  ).length;
  assert.equal(
    records.filter((r) => r.kind === "receipt").length,
    attempts,
    "one receipt per publication attempt",
  );
  return {
    records: parsed.lines.length,
    assertions: assertions.length,
    attempts,
    nodePauses,
    jvmPauses,
  };
}
