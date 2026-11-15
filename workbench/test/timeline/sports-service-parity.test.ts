import assert from "node:assert/strict";
import test from "node:test";
import {
  expectedReceipt,
  expectedState,
  projectReceipt,
  projectState,
  publications,
  retirementReceipt,
  views,
} from "../../scripts/sports-parity-oracle.js";

test("Sports parity distinguishes absent, established zero, correction, withdrawal and retired facts", () => {
  const absent = expectedState("empty", "match-market");
  assert.equal("homeScore" in absent.data, false);
  assert.equal(absent.status.fields.homeScore.freshness, "absent");
  const zero = expectedState("awayBaseline", "match-market");
  assert.equal(zero.data.homeScore, 0);
  assert.equal(zero.status.publication, "ready");
  assert.deepEqual(zero.data.homeGoals, [
    {
      birthSequence: 2,
      revision: 1,
      payload: { points: 0, observedAt: 1700000000200 },
    },
  ]);
  assert.equal(expectedState("corrected", "scoreboard").data.homeScore, 2);
  assert.equal(expectedState("corrected", "first-reported").data.homeScore, 1);
  assert.equal(expectedState("withdrawn", "scoreboard").data.homeScore, 0);
  assert.equal(expectedState("withdrawn", "first-reported").data.homeScore, 1);
  assert.deepEqual(
    expectedState("withdrawn", "scoreboard").status.fields.homeScore.facts,
    { minimumBirthSequence: 1, retainedCount: 2, activeCount: 1 },
  );
  const retired = expectedState("allRetired", "match-market");
  assert.deepEqual(retired.data.homeGoals, []);
  assert.equal(retired.data.homeScore, 0);
  assert.deepEqual(retired.status.fields.homeScore.facts, {
    minimumBirthSequence: 7,
    retainedCount: 0,
    activeCount: 0,
  });
  assert.deepEqual(
    expectedState("newBaseline", "match-market").data.homeGoals,
    [
      {
        birthSequence: 8,
        revision: 1,
        payload: { points: 0, observedAt: 1700000000800 },
      },
    ],
  );
});

test("Sports source outcomes retain global rejection versus committed target rejection and duplicate targets", () => {
  const unknown = expectedReceipt("correction", "unknown");
  assert.equal(unknown.status, "rejected");
  assert.equal(unknown.reason, "unknownFact");
  assert.deepEqual(unknown.changedViews, []);
  assert.deepEqual(unknown.targets, [
    {
      viewId: "match-market",
      entityId: "match-1",
      status: "rejected",
      reason: "unknownFact",
      changedFields: [],
      fields: [
        {
          field: "homeGoals",
          status: "rejected",
          reason: "unknownFact",
          changed: false,
        },
      ],
    },
  ]);
  const outside = expectedReceipt("outside", "outside");
  assert.equal(outside.status, "committed");
  assert.equal(outside.reason, "sqlite");
  assert.deepEqual(outside.changedViews, views);
  assert.ok(
    outside.targets.every((target) => target.reason === "factOutsideRetention"),
  );
  const duplicate = expectedReceipt("goal", "duplicate");
  assert.equal(duplicate.reason, "alreadyCommitted");
  assert.deepEqual(duplicate.targets, expectedReceipt("goal").targets);
  assert.deepEqual(duplicate.changedViews, []);
  assert.equal(publications.outside.publicationSequence, 7);
  assert.equal(publications.newBaseline.publicationSequence, 8);
  assert.deepEqual(expectedReceipt("newBaseline").targets[1].changedFields, []);
});

test("Sports parity retains per-view retirement atomicity and complete acknowledgement semantics", () => {
  assert.deepEqual(retirementReceipt("scoreboard", "rejected"), {
    kind: "factRetirement",
    status: "rejected",
    reason: "unknownFactField",
    control: {
      viewId: "scoreboard",
      entityId: "match-1",
      fields: ["homeScore", "missing"],
      minimumBirthSequence: 7,
    },
    floors: {},
    changedViews: [],
  });
  assert.equal(
    expectedState("marketRetired", "scoreboard").status.fields.homeScore.facts!
      .minimumBirthSequence,
    1,
  );
  assert.equal(
    expectedState("marketRetired", "match-market").status.fields.homeScore
      .facts!.minimumBirthSequence,
    7,
  );
  assert.equal(
    expectedState("scoreboardRetired", "first-reported").data.homeScore,
    1,
  );
  assert.deepEqual(
    retirementReceipt("match-market", "unchanged").changedViews,
    [],
  );
});

test("Sports common projection preserves payload clocks, fact status, progress and freshness", () => {
  const value = expectedState("watermark", "match-market");
  value.version = 100;
  value.type = "view-update";
  value.status.fields.market.receivedAtMillis = 1800000000000;
  assert.deepEqual(
    projectState(value),
    expectedState("watermark", "match-market"),
  );
  assert.deepEqual(value.status.inputs.bookmaker, {
    state: "observed",
    mode: "contiguousSequence",
    epoch: "run",
    sourceEntityId: "match-1",
    startSequence: 1,
    observedThrough: 3,
    watermarkThrough: 3,
    completeThrough: null,
    completeness: "incomplete",
    admissionFloor: 1,
    sourceContractViolated: false,
    missingRanges: [{ from: 2, through: 2, status: "confirmed" }],
  });
  const changed = structuredClone(value);
  (changed.data.market as { observedAt: number }).observedAt++;
  assert.notDeepEqual(projectState(changed), projectState(value));
  changed.data = value.data;
  changed.status.fields.market.freshness = "stale";
  assert.notDeepEqual(projectState(changed), projectState(value));
  const receipt = expectedReceipt("goal");
  assert.deepEqual(projectReceipt({ ...receipt, version: 22 }), receipt);
  assert.notDeepEqual(
    projectReceipt({ ...receipt, status: "rejected" }),
    receipt,
  );
});

test("Sports retraction carries no payload and public snapshots expose ordinary values", () => {
  assert.deepEqual(publications.withdrawal.payload, {});
  assert.deepEqual(publications.withdrawal.fact, {
    birthSequence: 4,
    revision: 3,
    operation: "retract",
  });
  assert.notDeepEqual(
    { points: 0, observedAt: 1700000000600 },
    publications.withdrawal.payload,
  );
  const state = expectedState("marketOne", "match-market");
  assert.deepEqual(state.data.match, {
    status: "live",
    observedAt: 1700000000000,
    cycle: 1,
  });
  assert.deepEqual(state.publicationSequences.match, [1]);
  const wrapped = structuredClone(state);
  wrapped.data.match = { publicationSequence: 1, payload: state.data.match };
  assert.notDeepEqual(
    projectState(wrapped),
    projectState(state),
    "Internal retained envelopes are not the HTTP/client contract",
  );
});
