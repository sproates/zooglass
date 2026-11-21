import assert from "node:assert/strict";
import test from "node:test";
import {
  explanationModel,
  reportLimits,
  type ExplanationInput,
} from "../../src/explanation/model.js";
import {
  renderExplanation,
  terminalText,
} from "../../src/explanation/render.js";
import type { TraceEvent } from "../../src/timeline/trace-generations.js";
import { parseJson } from "../../src/timeline/json.js";

const json = (value: unknown) => parseJson(JSON.stringify(value));
function event(
  id: string,
  kind: string,
  parent: string | null,
  data: unknown,
): TraceEvent {
  return {
    id,
    kind,
    parent,
    causes: [],
    actor: "source",
    timeMs: 10,
    key: [10, 0, 1, 0],
    runtimeGeneration: 2,
    connectionGeneration: 2,
    data: json(data) as TraceEvent["data"],
  };
}
function evidence(): ExplanationInput {
  const stream = { sourceId: "feed", epoch: "epoch", sourceEntityId: "item" };
  const attempt = event("attempt", "action", null, {
    actionId: "send",
    actionKind: "source-send",
    publication: "input",
  });
  const receipt = event("receipt", "receipt", "attempt", {
    envelope: {
      stream,
      publicationSequence: 1,
      version: 2,
      status: "applied",
      reason: "memory",
      payload: "must-not-render",
    },
  });
  const decision = event("decision", "publication-decision", "attempt", {
    envelope: {
      availability: "recorded",
      decision: {
        stream,
        publicationSequence: 1,
        version: 2,
        status: "applied",
        reason: "memory",
        installed: true,
        targets: [
          {
            viewId: "view",
            entityId: "item",
            fields: [
              {
                field: "latest",
                strategy: "latestBySequence",
                update: "LATEST_OLDER",
                retainedChanged: false,
                publicChanged: false,
              },
              {
                field: "history",
                strategy: "historyBySequence",
                update: "HISTORY_INSERTED",
                retainedChanged: true,
                publicChanged: true,
              },
            ],
          },
        ],
      },
    },
  });
  const delivery = event("delivery", "delivered", "receipt", {
    channel: "source-receipt",
    envelope: receipt.data.envelope,
  });
  const other = event("other", "action", null, {
    actionId: "unrelated",
    actionKind: "connect",
  });
  return {
    profile: "static-views-restart-v1",
    format: "timeline-trace/v5",
    outcome: "passed",
    evidence: { manifestSha256: "a".repeat(64), traceSha256: "b".repeat(64) },
    events: [attempt, receipt, decision, delivery, other],
    publicationDecisions: [{ event: decision, receipt, attempt }],
  };
}

test("report presents independent recorded field reasons and exact causal context without payloads", () => {
  const report = explanationModel(evidence(), "delivery");
  assert.deepEqual(
    report.entries.map((entry) => entry.eventId),
    ["attempt", "receipt", "decision", "delivery"],
  );
  assert.equal(report.replayStatus, "not-run");
  const entry = report.entries.find((entry) => entry.eventId === "decision")!;
  assert.ok("decision" in entry && entry.decision.availability === "recorded");
  assert.deepEqual(
    entry.decision.targets[0].fields.map((field) => [
      field.update,
      field.retainedChanged,
      field.publicChanged,
    ]),
    [
      ["LATEST_OLDER", false, false],
      ["HISTORY_INSERTED", true, true],
    ],
  );
  assert.equal(
    entry.decision.targets[0].fields[0].explanation,
    "Kept the contribution because the incoming sequence was older.",
  );
  assert.equal(entry.decision.publication?.publicationSequence, "1");
  const rendered = renderExplanation(report, "text");
  assert.match(rendered, /Attempt: attempt; receipt: receipt/);
  assert.match(rendered, /LATEST_OLDER/);
  assert.doesNotMatch(rendered, /must-not-render|unrelated/);
  assert.equal(
    renderExplanation(report, "json"),
    renderExplanation(explanationModel(evidence(), "delivery"), "json"),
  );
  assert.deepEqual(JSON.parse(renderExplanation(report, "json")), report);
  assert.throws(
    () => explanationModel(evidence(), "missing"),
    /Unknown event ID/,
  );
});

test("duplicate original detail uses only the validated lineage association", () => {
  for (const original of [undefined, "original-decision"]) {
    const input = evidence();
    const association = input.publicationDecisions[0];
    association.event.data = json({
      envelope: {
        availability: "recorded",
        decision: {
          stream: { sourceId: "feed", epoch: "epoch", sourceEntityId: "item" },
          publicationSequence: 1,
          version: 2,
          status: "duplicate",
          reason: "alreadyApplied",
          installed: false,
          targets: [],
        },
      },
    }) as TraceEvent["data"];
    association.original = original;
    const entry = explanationModel(input).entries.find(
      (entry) => entry.eventId === "decision",
    )!;
    assert.ok(
      "decision" in entry && entry.decision.availability === "recorded",
    );
    assert.equal(entry.decision.originalDecisionEventId, original ?? null);
    assert.equal(
      entry.decision.originalDetail,
      original ? "recorded" : "unavailable",
    );
    assert.deepEqual(entry.decision.targets, []);
    assert.match(entry.decision.explanation, /historical processing/);
  }
});

test("failure and legacy reports keep unavailable details explicit without claiming rollback", () => {
  const input = evidence();
  input.publicationDecisions[0].event.data = json({
    envelope: { availability: "unavailable", reason: "processingFailure" },
  }) as TraceEvent["data"];
  const rendered = renderExplanation(explanationModel(input), "text");
  assert.match(rendered, /does not establish whether state was installed/);
  assert.doesNotMatch(rendered, /installed: false|LATEST_OLDER/);
  const legacy = explanationModel({
    ...evidence(),
    format: "timeline-trace/v4",
    events: evidence().events.filter(
      (event) => event.kind !== "publication-decision",
    ),
    publicationDecisions: [],
  });
  assert.equal(legacy.coverage.detailedRuntimeDecisions, "not-recorded");
  assert.equal(legacy.coverage.observedReceiptCount, 1);
  assert.match(
    renderExplanation(legacy, "text"),
    /did not record detailed runtime reasons/,
  );
});

test("text controls are escaped and report limits reject instead of truncating", () => {
  const input = evidence();
  input.events[0].actor = "source\u001b[31m\n\u202e";
  const text = renderExplanation(explanationModel(input), "text");
  assert.ok(text.includes("source\\u001b[31m\\u000a\\u202e"));
  assert.ok(!text.includes("\u001b"));
  assert.equal(terminalText("x\u009by"), "x\\u009by");
  assert.throws(
    () =>
      explanationModel({
        ...input,
        events: Array(reportLimits.entries + 1).fill(input.events[0]),
      }),
    /entry limit/,
  );
  const report = explanationModel(input);
  report.notes.push("x".repeat(reportLimits.bytes));
  for (const format of ["text", "json"] as const)
    assert.throws(() => renderExplanation(report, format), /byte limit/);
});
