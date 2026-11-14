import assert from "node:assert/strict";
import { buildDocument as ordinary } from "../scenarios/timeline-sports/author.js";
import { inputs } from "../scenarios/timeline-sports/inputs.js";
import {
  progressReceipt,
  retirementReceipt,
} from "../scenarios/timeline-sports/receipts.js";
import { buildDocument as retention } from "../scenarios/timeline-sports-retention/author.js";
import {
  retirementReceipts,
  progressReceipt as retentionProgress,
} from "../scenarios/timeline-sports-retention/oracle.js";
import type {
  CampaignMode,
  DocumentRun,
} from "../src/timeline/campaign-checks.js";
import { canonicalJson, encodeJson } from "../src/timeline/json.js";
import { restartEvidence } from "./restart-campaign-evidence.js";
export type SportsGroup = "ordinary" | "retention";
export type SportsCounts = {
  group: SportsGroup;
  records: number;
  commands: number;
  receipts: number;
  controls: number;
  frames: number;
  pauses: [string, number][];
};
// Workload bookkeeping is frozen after the reviewed fixtures' first successful
// execution. It is distinct from their pre-execution correctness expectations.
export const sportsCounts: readonly SportsCounts[] = [
  {
    group: "ordinary",
    records: 1973,
    commands: 647,
    receipts: 114,
    controls: 15,
    frames: 105,
    pauses: [
      ["state-effect", 10],
      ["writer-handoff", 0],
      ["alarm-dispatch", 33011],
    ],
  },
  {
    group: "retention",
    records: 343,
    commands: 113,
    receipts: 25,
    controls: 7,
    frames: 0,
    pauses: [["state-effect", 10]],
  },
];
export const authoredSportsDocument = (group: SportsGroup) =>
  group === "ordinary" ? ordinary() : retention();
const canonical = (value: unknown) => canonicalJson(JSON.stringify(value));

/** Authored correctness, exact equality and measured host perturbation are separate gates. */
export function checkSportsCampaignRun(
  raw: string,
  baseline: DocumentRun | undefined,
  mode: CampaignMode,
  expected: SportsCounts,
) {
  const { run, parsed, byKind } = restartEvidence(raw, baseline, "sqlite");
  const document = authoredSportsDocument(expected.group);
  assert.equal(run.scenario, canonical(document));
  assert.equal(run.execution.profile, "sqlite-sports-v1");
  assert.equal(run.execution.configurationSha256, document.runtime.sha256);
  assert.equal(
    parsed.lines.length,
    expected.records,
    "complete trace record count",
  );
  assert.equal(
    run.diagnostics.retainedStore,
    undefined,
    "passing case retained a database",
  );
  assert.match(run.environment.java.sqliteVersion, /^\d+\.\d+\.\d+/);
  const assertions = byKind("assertion");
  assert.equal(
    assertions.length,
    document.assertions.length,
    "all authored assertions",
  );
  assertions.forEach((event, index) => {
    const wanted = document.assertions[index];
    assert.deepEqual(
      [
        event.time,
        event.data.assertionId,
        event.data.assertionKind,
        event.actor,
      ],
      [
        wanted.atMs,
        wanted.id,
        wanted.kind,
        "actor" in wanted ? wanted.actor : "@runtime",
      ],
    );
    assert.equal(event.data.passed, true);
    assert.equal(
      encodeJson(event.data.expected),
      canonical(wanted.expected),
      "unchanged independent expectation",
    );
    assert.equal(
      encodeJson(event.data.actual),
      canonical(wanted.expected),
      "complete independent actual",
    );
  });
  assert.equal(byKind("receipt").length, expected.receipts);
  assert.equal(byKind("control-receipt").length, expected.controls);
  assert.equal(
    byKind("delivered").filter((event) => event.data.channel === "client-frame")
      .length,
    expected.frames,
  );
  for (const kind of ["source-receipts", "control-receipts", "client-frames"]) {
    const finals = new Map<string, unknown>();
    for (const row of document.assertions)
      if (row.kind === kind && "actor" in row)
        finals.set(row.actor, row.expected);
    for (const [actor, wanted] of finals) {
      const actual =
        kind === "source-receipts"
          ? byKind("receipt").filter((event) => event.actor === actor)
          : byKind("delivered").filter(
              (event) =>
                event.actor === actor &&
                (kind === "client-frames"
                  ? event.data.channel === "client-frame"
                  : ["progress-receipt", "retirement-receipt"].includes(
                      String(event.data.channel),
                    )),
            );
      assert.equal(
        encodeJson(actual.map((event) => event.data.envelope)),
        canonical(wanted),
        `all ${kind} for ${actor}`,
      );
    }
  }
  const controls =
    expected.group === "ordinary"
      ? inputs().flatMap<unknown>((input) =>
          input.kind === "progress"
            ? [progressReceipt(input)]
            : input.kind === "retirement"
              ? [retirementReceipt(input)]
              : [],
        )
      : [
          ...retirementReceipts.slice(0, 4),
          retentionProgress,
          ...retirementReceipts.slice(4),
        ];
  assert.equal(
    encodeJson(byKind("control-receipt").map((event) => event.data.envelope)),
    canonical(controls),
    "full control emissions including lost reply",
  );
  const initialized = byKind("runtime-initialized");
  assert.equal(initialized.length, 1);
  assert.equal(initialized[0].time, 0);
  assert.equal(initialized[0].generation, 1);
  assert.equal(
    byKind("fault-decision").length,
    0,
    "no redundant seed coverage",
  );
  assert.deepEqual(
    [
      run.diagnostics.hostDelayMs,
      run.diagnostics.paced,
      run.diagnostics.idlePauseMs,
    ],
    [mode.hostDelay, mode.paced, mode.idlePauseMs],
  );
  const generations = run.diagnostics.generations;
  assert.equal(generations?.length, 1);
  const timing = generations![0];
  assert.equal(timing.runtimeGeneration, 1);
  assert.equal(timing.jvm?.pauseMillis, mode.jvmPauseMs);
  assert.deepEqual(
    timing.jvm?.pauses.map((p) => [p.site, p.virtualMs]).sort(),
    mode.jvmPauseMs ? [...expected.pauses].sort() : [],
  );
  for (const pause of timing.jvm!.pauses) {
    assert.equal(pause.requestedMillis, mode.jvmPauseMs);
    assert.ok(
      Number.isSafeInteger(pause.elapsedNanos) &&
        pause.elapsedNanos >= mode.jvmPauseMs * 1e6,
    );
  }
  assert.equal(
    timing.node.length,
    mode.hostDelay ? expected.commands : 0,
    "complete Node command pauses",
  );
  timing.node.forEach((pause, index) => {
    assert.equal(pause.turn, index);
    assert.equal(pause.requestedMillis, mode.hostDelay);
    assert.ok(
      Number.isSafeInteger(pause.elapsedNanos) &&
        pause.elapsedNanos > 50_000_000,
    );
  });
  if (mode.hostDelay) {
    assert.deepEqual(
      [timing.node[0].operation, timing.node[0].timeMs],
      ["initialize-document", 0],
    );
    for (const op of ["ingress", "progress", "retirement", "observe-installed"])
      assert.ok(
        timing.node.some((p) => p.operation === op),
        `missing ${op} pause`,
      );
  }
  return run;
}
