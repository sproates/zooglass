import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import type { PreparedCheckpoint } from "../../control/prepared-checkpoints.js";
import type { openSportsRun } from "./run.js";

type Run = Awaited<ReturnType<typeof openSportsRun>>;
interface Snapshot {
  data: {
    match?: { cycle: number; scoreWindowStart: number };
    homeScore?: number;
    awayScore?: number;
    homeGoals?: { payload: { scorer?: string; kind: string } }[];
    market?: { basedOnMatchSequence: number };
  };
  status: {
    fields: Record<
      string,
      {
        freshness: string;
        facts?: { minimumBirthSequence: number; activeCount: number };
      }
    >;
    inputs: Record<
      string,
      {
        observedThrough: number;
        missingRanges: { from: number; through: number; status: string }[];
      }
    >;
  };
}
async function read(
  run: Run,
  signal: AbortSignal,
  view = "match-market",
  id = "match-1",
): Promise<Snapshot> {
  const response = await fetch(`${run.baseUrl}/views/${view}/${id}`, {
    signal: AbortSignal.any([signal, run.signal, AbortSignal.timeout(3000)]),
  });
  if (!response.ok)
    throw new Error(`Snapshot request failed: ${response.status}`);
  return response.json();
}
async function scores(
  run: Run,
  signal: AbortSignal,
  home: number,
  away: number,
  firstHome = home,
  firstAway = away,
) {
  for (const view of ["match-market", "scoreboard", "first-reported"]) {
    const { data } = await read(run, signal, view);
    assert.equal(data.homeScore, view === "first-reported" ? firstHome : home);
    assert.equal(data.awayScore, view === "first-reported" ? firstAway : away);
  }
}
function checkpoint(
  name: string,
  label: string,
  check: (run: Run, signal: AbortSignal) => Promise<void>,
  cycle = 1,
  entityId = "match-1",
): PreparedCheckpoint<Run> {
  return {
    id: `${cycle}/${entityId}/${name}`,
    label,
    async execute(run, signal) {
      await run.advance(cycle, entityId, name);
      await check(run, signal);
    },
  };
}
const scorerNames = (snapshot: Snapshot) =>
  snapshot.data.homeGoals
    ?.filter((f) => f.payload.kind === "goal")
    .map((f) => f.payload.scorer);

/** Hand-authored outcomes from real views; never calculate scores from goal lists. */
export const sportsCheckpoints: PreparedCheckpoint<Run>[] = [
  checkpoint(
    "metadata",
    "Kick-off received; scores await both baselines",
    async (run, signal) => {
      const snapshot = await read(run, signal);
      assert.equal(snapshot.data.match?.cycle, 1);
      assert.equal(snapshot.status.fields.homeScore.facts?.activeCount ?? 0, 0);
    },
  ),
  checkpoint(
    "home-baseline",
    "Home baseline alone is not a complete score",
    async (run, signal) => {
      const snapshot = await read(run, signal);
      assert.equal(snapshot.status.fields.homeScore.facts?.activeCount, 1);
      assert.equal(snapshot.status.fields.awayScore.facts?.activeCount ?? 0, 0);
    },
  ),
  checkpoint(
    "both-baselines",
    "Both baselines establish a genuine 0–0",
    (r, s) => scores(r, s, 0, 0),
  ),
  checkpoint(
    "first-goal",
    "Alex scores; all three views show 1–0",
    async (r, s) => {
      await scores(r, s, 1, 0);
      assert.deepEqual(scorerNames(await read(r, s)), ["Alex Vale"]);
    },
  ),
  checkpoint(
    "unknown-fact",
    "Correction before its goal is rejected without advancing progress",
    async (r, s) => {
      await scores(r, s, 1, 0);
      assert.equal(
        (await read(r, s)).status.inputs["match-feed"].observedThrough,
        4,
      );
    },
  ),
  checkpoint(
    "corrected-scorer",
    "Create then retry: Taylor replaces Sam only in corrected views",
    async (r, s) => {
      await scores(r, s, 2, 0);
      assert.deepEqual(scorerNames(await read(r, s)), [
        "Alex Vale",
        "Taylor Brook",
      ]);
      assert.deepEqual(scorerNames(await read(r, s, "first-reported")), [
        "Alex Vale",
        "Sam Reed",
      ]);
    },
  ),
  checkpoint(
    "withdrawal",
    "Withdrawal makes corrected 1–0; first-reported remains 2–0",
    async (r, s) => {
      await scores(r, s, 1, 0, 2, 0);
      assert.deepEqual(scorerNames(await read(r, s)), ["Taylor Brook"]);
      assert.deepEqual(
        (await read(r, s)).status.inputs["match-feed"].missingRanges,
        [{ from: 7, through: 7, status: "provisional" }],
      );
    },
  ),
  checkpoint(
    "obsolete-revision",
    "Late obsolete correction closes the gap without restoring Alex",
    async (r, s) => {
      await scores(r, s, 1, 0, 2, 0);
      assert.deepEqual(
        (await read(r, s)).status.inputs["match-feed"].missingRanges,
        [],
      );
    },
  ),
  checkpoint("duplicate", "Exact retry has no additional effect", (r, s) =>
    scores(r, s, 1, 0, 2, 0),
  ),
  checkpoint(
    "behind-market",
    "Bookmaker odds reference an earlier feed boundary",
    async (r, s) => {
      const snapshot = await read(r, s);
      assert.equal(snapshot.data.market?.basedOnMatchSequence, 6);
      assert.equal(snapshot.status.inputs["match-feed"].observedThrough, 8);
    },
  ),
  checkpoint(
    "market-watermark",
    "Watermark confirms the missing bookmaker report",
    async (r, s) => {
      assert.deepEqual(
        (await read(r, s)).status.inputs.bookmaker.missingRanges,
        [{ from: 2, through: 2, status: "confirmed" }],
      );
    },
  ),
  checkpoint(
    "current-market",
    "New market basis matches known feed progress",
    async (r, s) => {
      assert.equal((await read(r, s)).data.market?.basedOnMatchSequence, 8);
      await scores(r, s, 1, 0, 2, 0);
    },
  ),
  checkpoint(
    "all-goals-withdrawn",
    "Both withdrawals return corrected scores to 0–0",
    (r, s) => scores(r, s, 0, 0, 2, 1),
  ),
  checkpoint(
    "finished",
    "Matches continue while the bookmaker is silent; wait for stale status",
    async (r, s) => {
      const deadline = AbortSignal.any([
        s,
        r.signal,
        AbortSignal.timeout(20000),
      ]);
      while (
        (await read(r, deadline)).status.fields.market.freshness !== "stale"
      ) {
        await delay(50, undefined, { signal: deadline });
      }
      await scores(r, s, 0, 0, 2, 1);
    },
    1,
    "match-3",
  ),
  checkpoint(
    "bookmaker-reconnected",
    "Reconnection alone does not refresh the saved market",
    async (r, s) => {
      assert.equal((await read(r, s)).status.fields.market.freshness, "stale");
    },
  ),
  checkpoint(
    "market-refreshed",
    "New bookmaker reports refresh all three markets",
    async (r, s) => {
      for (const id of ["match-1", "match-2", "match-3"])
        assert.equal(
          (await read(r, s, "match-market", id)).status.fields.market.freshness,
          "fresh",
        );
    },
    1,
    "match-3",
  ),
  checkpoint(
    "retired",
    "Old goal windows retire; scores enter transition",
    async (r, s) => {
      for (const view of ["match-market", "scoreboard", "first-reported"]) {
        const snapshot = await read(r, s, view);
        assert.equal(
          snapshot.status.fields.homeScore.facts?.minimumBirthSequence,
          14,
        );
        assert.equal(snapshot.status.fields.homeScore.facts?.activeCount, 0);
        assert.equal(snapshot.data.match?.scoreWindowStart, 1);
      }
    },
    2,
  ),
  checkpoint(
    "outside-retention",
    "Old duplicate and delayed correction cannot restore retired goals",
    async (r, s) => {
      assert.equal(
        (await read(r, s)).status.fields.homeScore.facts?.activeCount,
        0,
      );
    },
    2,
  ),
  checkpoint(
    "metadata",
    "New cycle metadata still waits for its score baselines",
    async (r, s) => {
      const snapshot = await read(r, s);
      assert.equal(snapshot.data.match?.cycle, 2);
      assert.equal(snapshot.data.match?.scoreWindowStart, 14);
      assert.equal(snapshot.status.fields.homeScore.facts?.activeCount, 0);
    },
    2,
  ),
  checkpoint(
    "home-baseline",
    "New home baseline alone still cannot establish a score",
    async (r, s) => {
      const snapshot = await read(r, s);
      assert.equal(snapshot.status.fields.homeScore.facts?.activeCount, 1);
      assert.equal(snapshot.status.fields.awayScore.facts?.activeCount, 0);
    },
    2,
  ),
  checkpoint(
    "both-baselines",
    "Fresh windows restore 0–0 across all views; walkthrough complete",
    async (r, s) => {
      await scores(r, s, 0, 0);
      for (const id of ["match-1", "match-2", "match-3"]) {
        const snapshot = await read(r, s, "scoreboard", id);
        assert.equal(snapshot.data.match?.cycle, 2);
        assert.equal(snapshot.data.homeScore, 0);
        assert.equal(snapshot.data.awayScore, 0);
      }
    },
    2,
    "match-3",
  ),
];
