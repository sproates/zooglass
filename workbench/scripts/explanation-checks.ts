import assert from "node:assert/strict";
import { parseReplay } from "../src/timeline/replay-document.js";
import { encodeJson, parseJson } from "../src/timeline/json.js";
import { list, object, text } from "../src/timeline/validation.js";
import type { ExplanationReport } from "../src/explanation/model.js";
import type { DocumentRun } from "../src/timeline/campaign-checks.js";

export const explanationCases = [
  "memory",
  "sqlite",
  "rejected",
  "assertion-failure",
  "legacy",
] as const;
export type ExplanationCase = (typeof explanationCases)[number];
const first = [
  ["arrival", "ARRIVAL_REPLACED", true, true],
  ["history", "HISTORY_INSERTED", true, true],
  ["latest", "LATEST_INITIAL", true, true],
];
const sameValue = [
  ["arrival", "ARRIVAL_REPLACED", true, false],
  ["history", "HISTORY_INSERTED", true, true],
  ["latest", "LATEST_NEWER", true, false],
];
const older = [
  ["arrival", "ARRIVAL_REPLACED", true, true],
  ["history", "HISTORY_INSERTED", true, true],
  ["latest", "LATEST_OLDER", false, false],
];

/** Literal business witnesses keyed by authored action IDs, not generated report snapshots. */
export function checkExplanationCase(
  name: ExplanationCase,
  run: DocumentRun,
  report: ExplanationReport,
) {
  const saved = parseReplay(JSON.stringify(run));
  const expectedOutcome =
    name === "assertion-failure" ? "assertion-failed" : "passed";
  assert.equal(
    run.outcome,
    expectedOutcome,
    run.message ?? "unexpected scenario outcome",
  );
  assert.equal(report.recordedOutcome, expectedOutcome);
  assert.equal(report.replayStatus, "not-run");
  const events = saved.trace.events;
  const decisions = events.filter(
    (event) => event.kind === "publication-decision",
  );
  if (name === "legacy") {
    assert.equal(decisions.length, 0);
    assert.equal(report.coverage.detailedRuntimeDecisions, "not-recorded");
    assert.ok(report.entries.some((entry) => entry.kind === "receipt"));
    return { outcome: expectedOutcome, decisions: 0, witnesses: [] };
  }
  assert.equal(report.coverage.detailedRuntimeDecisions, "recorded");
  const actions = events.filter(
    (event) =>
      event.kind === "action" &&
      ["source-send", "source-retry"].includes(String(event.data.actionKind)),
  );
  assert.equal(
    actions.length,
    name === "rejected" ? 2 : name === "assertion-failure" ? 1 : 6,
  );
  assert.equal(decisions.length, actions.length);
  const references = new Map<string, string>();
  const witnesses = actions.map((attempt) => {
    const action = text(attempt.data.actionId, "actionId");
    const recorded = decisions.filter((event) => event.parent === attempt.id);
    const receipts = events.filter(
      (event) => event.kind === "receipt" && event.parent === attempt.id,
    );
    assert.equal(recorded.length, 1);
    assert.equal(receipts.length, 1);
    const event = recorded[0];
    assert.equal(event.actor, attempt.actor);
    assert.equal(event.runtimeGeneration, attempt.runtimeGeneration);
    assert.equal(event.connectionGeneration, attempt.connectionGeneration);
    const envelope = object(event.data.envelope, "envelope");
    assert.equal(envelope.availability, "recorded");
    const decision = object(envelope.decision, "decision");
    const rejected = name === "rejected" && action === "same-value";
    const duplicate =
      action.startsWith("retry-") ||
      (name === "sqlite" && action === "after-restart");
    assert.equal(
      decision.status,
      rejected
        ? "rejected"
        : duplicate
          ? "duplicate"
          : name === "sqlite"
            ? "committed"
            : "applied",
    );
    assert.equal(decision.installed, !rejected && !duplicate);
    if (rejected) assert.equal(decision.reason, "historyLimit");
    const expected =
      rejected || duplicate
        ? []
        : action === "same-value"
          ? sameValue
          : action === "older-alias"
            ? older
            : first;
    const targets = list(decision.targets, "targets");
    assert.equal(targets.length, expected.length ? 1 : 0);
    const fields = targets.flatMap((target) =>
      list(object(target, "target").fields, "fields").map((value) => {
        const field = object(value, "field");
        return [
          field.field,
          field.update,
          field.retainedChanged,
          field.publicChanged,
        ];
      }),
    );
    assert.deepEqual(
      fields,
      expected,
      `independent decision oracle: ${action}`,
    );
    const entry = report.entries.find((entry) => entry.eventId === event.id);
    assert.ok(entry && "decision" in entry);
    assert.equal(entry.decision.attemptEventId, attempt.id);
    assert.equal(entry.decision.receiptEventId, receipts[0].id);
    assert.equal(entry.decision.availability, "recorded");
    if (entry.decision.availability !== "recorded")
      throw new Error("Missing report decision");
    assert.deepEqual(
      entry.decision.targets.flatMap((target) =>
        target.fields.map((field) => [
          field.field,
          field.update,
          field.retainedChanged,
          field.publicChanged,
        ]),
      ),
      expected,
    );
    let original: string | undefined;
    if (duplicate) {
      const originalAction =
        action === "retry-older"
          ? "older-alias"
          : name === "sqlite"
            ? "first"
            : "after-restart";
      original = references.get(originalAction);
      assert.ok(original);
      assert.equal(entry.decision.originalDecisionEventId, original);
      if (name === "memory") assert.notEqual(original, references.get("first"));
    }
    references.set(action, event.id);
    return {
      action,
      eventId: event.id,
      attemptEventId: attempt.id,
      receiptEventId: receipts[0].id,
      original: original ?? null,
      fields,
    };
  });
  return { outcome: expectedOutcome, decisions: decisions.length, witnesses };
}

export function checkReasonMutant(
  normal: DocumentRun,
  mutant: DocumentRun,
  report: ExplanationReport,
) {
  assert.equal(
    mutant.outcome,
    "passed",
    mutant.message ?? "mutant changed scenario outcome",
  );
  assert.equal(normal.scenario, mutant.scenario);
  assert.equal(normal.configuration, mutant.configuration);
  assert.deepEqual(normal.environment, mutant.environment);
  assert.notEqual(
    normal.execution.artifactSha256,
    mutant.execution.artifactSha256,
  );
  assert.deepEqual(mutant.execution, {
    ...normal.execution,
    artifactSha256: mutant.execution.artifactSha256,
  });
  const records = (run: DocumentRun) =>
    parseReplay(JSON.stringify(run))
      .lines.slice(1)
      .map((line) => object(parseJson(line), "record"));
  const good = records(normal),
    bad = records(mutant);
  assert.equal(good.length, bad.length);
  let changed = 0;
  good.forEach((record, index) => {
    if (encodeJson(record) === encodeJson(bad[index])) return;
    assert.equal(record.kind, "publication-decision");
    assert.equal(encodeJson(record).split('"LATEST_OLDER"').length, 2);
    assert.equal(
      encodeJson(bad[index]),
      encodeJson(record).replace('"LATEST_OLDER"', '"LATEST_EQUAL"'),
    );
    changed++;
  });
  assert.equal(changed, 1, "exactly the older-alias reason changed");
  assert.throws(
    () => checkExplanationCase("memory", mutant, report),
    /independent decision oracle: older-alias/,
  );
  return {
    detected: true,
    changedRecords: changed,
    reason: "LATEST_OLDER became LATEST_EQUAL",
    unchangedNonDecisionRecords: true,
  };
}

export function checkExplanationPauses(
  normal: DocumentRun,
  paused: DocumentRun,
) {
  assert.equal(paused.trace, normal.trace, "paused semantic equality");
  assert.deepEqual(paused.environment, normal.environment);
  const pauses =
    paused.diagnostics.generations?.flatMap(
      (generation) => generation.jvm?.pauses ?? [],
    ) ?? [];
  for (const site of ["state-effect", "writer-handoff"])
    assert.ok(
      pauses.some(
        (pause) => pause.site === site && pause.requestedMillis === 70,
      ),
      `observed JVM pause at ${site}`,
    );
  for (const pause of pauses) {
    assert.equal(pause.requestedMillis, 70);
    assert.ok(pause.elapsedNanos >= 70_000_000);
    assert.ok(
      [0, 10, 20, 30, 70].includes(pause.virtualMs),
      "pause occurred at an expected virtual timestamp",
    );
  }
  return pauses.length;
}
