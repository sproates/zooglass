import assert from "node:assert/strict";
import test from "node:test";
import {
  SportsModel,
  score,
  goals,
  marketBasis,
  sameWindow,
  type ViewSnapshot,
} from "../../../demos/live-sports/src/model.js";
function snapshot(): ViewSnapshot {
  return {
    viewId: "match-market",
    entityId: "match-1",
    version: 10,
    data: {
      match: {
        home: "Harbour Athletic",
        away: "Hilltown",
        cycle: 2,
        period: "first-half",
        simulatedClock: "00:00",
        scoreWindowStart: 14,
      },
      homeScore: 7,
      awayScore: 3,
      homeGoals: [
        {
          birthSequence: 16,
          revision: 1,
          payload: { kind: "baseline", points: 0 },
        },
        {
          birthSequence: 18,
          revision: 2,
          payload: { kind: "goal", scorer: "Taylor", minute: 12, points: 1 },
        },
      ],
      market: {
        cycle: 2,
        status: "suspended",
        odds: { home: 2.1, draw: 3.2, away: 3.4 },
        basedOnMatchSequence: 20,
      },
    },
    provenance: {},
    publicationSequences: {},
    status: {
      publication: "ready",
      missingFields: [],
      missingRequiredFields: [],
      fields: Object.fromEntries(
        ["homeScore", "awayScore"].map((field) => [
          field,
          {
            freshness: "notTracked",
            receivedAtMillis: null,
            inputs: ["match-feed"],
            facts: {
              minimumBirthSequence: 14,
              retainedCount: 2,
              activeCount: 1,
            },
          },
        ]),
      ),
      inputs: {
        "match-feed": {
          state: "observed",
          mode: "contiguousSequence",
          epoch: "run",
          sourceEntityId: "match-1",
          observedThrough: 20,
          watermarkThrough: 20,
          completeThrough: 19,
          completeness: "incomplete",
          missingRanges: [{ from: 20, through: 20, status: "confirmed" }],
        },
      },
    },
  };
}
test("Sports displays supplied totals, never a sum of goals, and gates both score fields", () => {
  const state = snapshot();
  assert.deepEqual(score(state), {
    phase: "Current score",
    current: true,
    home: "7",
    away: "3",
  });
  assert.equal(goals(state, "home").length, 1);
  assert.equal(goals(state, "home")[0].payload.scorer, "Taylor");
  state.status.fields.awayScore.facts!.minimumBirthSequence = 1;
  assert.equal(score(state).phase, "Cycle transition");
  assert.equal(score(state).home, "—");
  state.status.fields.awayScore.facts!.minimumBirthSequence = 14;
  state.status.fields.awayScore.facts!.activeCount = 0;
  assert.equal(score(state).phase, "Awaiting score");
  state.data.homeScore = 0;
  state.data.awayScore = 0;
  assert.equal(score(state).current, false);
  state.status.fields.awayScore.facts!.activeCount = 1;
  assert.equal(score(state).home, "0");
  assert.equal(score(state).away, "0");
  assert.equal(score(undefined).phase, "Awaiting match");
});
test("market basis uses observed progress and matching cycles/windows, not fact publicationSequences", () => {
  const state = snapshot();
  assert.equal(
    marketBasis(state),
    "Market references the observed feed boundary",
  );
  state.status.inputs["match-feed"].observedThrough = 21;
  assert.equal(
    marketBasis(state),
    "Market references an earlier feed boundary",
  );
  state.status.inputs["match-feed"].observedThrough = 19;
  assert.equal(marketBasis(state), "Feed basis beyond known progress");
  state.status.fields.homeScore.facts!.activeCount = 0;
  assert.equal(
    marketBasis(state),
    "Score window transitioning · market not current",
  );
  state.data.market = { ...(state.data.market as object), cycle: 1 };
  assert.equal(marketBasis(state), "Previous-cycle market · not current");
});
test("Sports replaces all data/status on reconnect and keeps independent bounded view identities", () => {
  const model = new SportsModel();
  const state = snapshot();
  model.accept(state);
  model.connected = true;
  assert.equal(model.saved("match-market"), false);
  const scoreboard = {
    ...snapshot(),
    viewId: "scoreboard",
    data: { ...state.data, homeScore: 99 },
  };
  model.accept(scoreboard);
  assert.equal(score(model.get("scoreboard")).home, "99");
  assert.equal(score(model.get("match-market")).home, "7");
  model.beginConnection();
  assert.equal(model.saved("match-market"), true);
  const empty = {
    ...state,
    version: 0,
    data: {},
    status: { ...state.status, fields: {}, inputs: {} },
  };
  model.accept(empty);
  assert.deepEqual(model.get("match-market"), empty);
  assert.equal(score(model.get("match-market")).phase, "Awaiting match");
  assert.equal(model.snapshots.size, 2);
  assert.throws(
    () => model.accept({ ...state, entityId: "other" }),
    /identity/,
  );
  assert.throws(() => model.accept({ ...state, version: NaN }), /Incomplete/);
  const next = snapshot();
  assert.equal(sameWindow(state, next), true);
  next.status.fields.homeScore.facts!.minimumBirthSequence = 30;
  assert.equal(sameWindow(state, next), false);
});
