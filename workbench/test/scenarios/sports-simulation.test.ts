import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { sportsConfiguration } from "../../src/demos/sports/configuration.js";
import { startSportsProducer } from "../../src/demos/sports/producer.js";
import { startZooGlassSession } from "../../src/service/zooglass-session.js";
import { liveClient } from "../support/live-client.js";

const views = ["match-market", "scoreboard", "first-reported"];
async function read(base: string, view = "match-market", entity = "match-1") {
  const reply = await fetch(`${base}/views/${view}/${entity}`, {
    signal: AbortSignal.timeout(3000),
  });
  assert.equal(reply.status, 200);
  return reply.json();
}
async function lateSnapshot(base: string, view: string, entity: string) {
  const client = await liveClient(base);
  try {
    await client.send({ action: "subscribe", viewId: view, entityId: entity });
    assert.equal((await client.next()).type, "subscribed");
    return await client.next();
  } finally {
    await client.close();
  }
}
function goal(
  birthSequence: number,
  scorer: string,
  revision = 1,
  minute = 12,
) {
  return {
    birthSequence,
    revision,
    payload: { kind: "goal", cycle: 1, scorer, minute, points: 1 },
  };
}
const homeBaseline = {
  birthSequence: 2,
  revision: 1,
  payload: { kind: "baseline", cycle: 1, points: 0 },
};
const awayBaseline = {
  birthSequence: 3,
  revision: 1,
  payload: { kind: "baseline", cycle: 1, points: 0 },
};

test(
  "Sports real service: independent scores, fact policy receipts, gaps and cycle boundaries",
  { timeout: 60000 },
  async () => {
    const service = await startZooGlassSession({
      configuration: sportsConfiguration(),
    });
    let producer: Awaited<ReturnType<typeof startSportsProducer>> | undefined;
    let beforeUnknown: unknown;
    let beforeDuplicate: unknown;
    try {
      producer = await startSportsProducer(service.baseUrl, {
        cycles: 3,
        tickMs: 10,
        signal: service.signal,
        async onStep(step, receipts) {
          if (step.entityId !== "match-1") return;
          const states = await Promise.all(
            views.map((view) => read(service.baseUrl, view)),
          );
          const [current, scoreboard, first] = states;
          assert.equal(scoreboard.data.market, undefined);
          assert.equal(scoreboard.data.homeGoals, undefined);
          assert.equal(scoreboard.status.inputs.bookmaker, undefined);
          for (const state of states) {
            assert.equal(state.publicationSequences.homeScore, undefined);
            assert.equal(state.publicationSequences.homeGoals, undefined);
          }
          if (step.cycle === 1) {
            if (step.name === "metadata") {
              assert.equal(current.data.homeScore, undefined);
              assert.equal(current.data.awayScore, undefined);
            }
            if (step.name === "home-baseline") {
              assert.equal(current.data.homeScore, 0);
              assert.equal(current.data.awayScore, undefined);
            }
            if (step.name === "both-baselines") {
              assert.equal(current.data.homeScore, 0);
              assert.equal(current.data.awayScore, 0);
              assert.deepEqual(current.data.homeGoals, [homeBaseline]);
              assert.deepEqual(current.data.awayGoals, [awayBaseline]);
            }
            if (step.name === "first-goal") {
              assert.equal(current.data.homeScore, 1);
              assert.deepEqual(current.data.homeGoals, [
                homeBaseline,
                goal(4, "Alex Vale"),
              ]);
              beforeUnknown = states;
            }
            if (step.name === "unknown-fact") {
              assert.equal(receipts[0].status, "rejected");
              assert.equal(receipts[0].reason, "unknownFact");
              assert.deepEqual(states, beforeUnknown);
              assert.equal(
                current.status.inputs["match-feed"].observedThrough,
                4,
              );
            }
            if (
              step.name === "delayed-create" ||
              step.name === "corrected-scorer"
            ) {
              assert.equal(current.data.homeScore, 2);
              assert.equal(first.data.homeScore, 2);
              assert.deepEqual(current.data.homeGoals, [
                homeBaseline,
                goal(4, "Alex Vale"),
                step.name === "delayed-create"
                  ? goal(5, "Sam Reed")
                  : goal(5, "Taylor Brook", 2),
              ]);
              assert.deepEqual(first.data.homeGoals, [
                homeBaseline,
                goal(4, "Alex Vale"),
                goal(5, "Sam Reed"),
              ]);
              if (step.name === "corrected-scorer") {
                assert.equal(
                  receipts[0].status,
                  "committed",
                  "rejected identity must be reusable for exact retry",
                );
                assert.deepEqual(
                  receipts[0].targets
                    ?.find((t) => t.viewId === "first-reported")
                    ?.fields?.map((f) => [f.field, f.status, f.reason])
                    .sort(),
                  [
                    ["homeGoals", "rejected", "factImmutable"],
                    ["homeScore", "rejected", "factImmutable"],
                  ],
                );
              }
            }
            if (
              step.name === "withdrawal" ||
              step.name === "obsolete-revision" ||
              step.name === "duplicate"
            ) {
              assert.equal(current.data.homeScore, 1);
              assert.equal(scoreboard.data.homeScore, 1);
              assert.equal(first.data.homeScore, 2);
              assert.deepEqual(current.data.homeGoals, [
                homeBaseline,
                goal(5, "Taylor Brook", 2),
              ]);
              assert.deepEqual(
                current.status.inputs["match-feed"].missingRanges,
                step.name === "withdrawal"
                  ? [{ from: 7, through: 7, status: "provisional" }]
                  : [],
              );
              if (step.name === "obsolete-revision") {
                assert.deepEqual(
                  receipts[0].targets
                    ?.find((t) => t.viewId === "scoreboard")
                    ?.fields?.map((f) => [f.field, f.reason]),
                  [["homeScore", "obsoleteRevision"]],
                );
                beforeDuplicate = states;
              }
              if (step.name === "duplicate") {
                assert.equal(receipts[0].status, "duplicate");
                assert.deepEqual(states, beforeDuplicate);
              }
            }
            if (step.name === "behind-market") {
              assert.equal(current.data.market.basedOnMatchSequence, 6);
              assert.equal(
                current.status.inputs["match-feed"].observedThrough,
                8,
              );
              assert.deepEqual(current.status.inputs.bookmaker.missingRanges, [
                { from: 2, through: 2, status: "provisional" },
              ]);
            }
            if (step.name === "market-watermark")
              assert.deepEqual(current.status.inputs.bookmaker.missingRanges, [
                { from: 2, through: 2, status: "confirmed" },
              ]);
            if (step.name === "current-market")
              assert.equal(current.data.market.basedOnMatchSequence, 8);
            if (step.name === "all-goals-withdrawn") {
              assert.equal(current.data.homeScore, 0);
              assert.equal(current.data.awayScore, 0);
              assert.deepEqual(current.data.homeGoals, [homeBaseline]);
              assert.deepEqual(current.data.awayGoals, [awayBaseline]);
              assert.equal(
                current.status.fields.homeScore.facts.activeCount,
                1,
              );
              assert.equal(
                current.status.fields.awayScore.facts.activeCount,
                1,
              );
              assert.equal(first.data.homeScore, 2);
              assert.equal(first.data.awayScore, 1);
            }
          }
          if (
            step.cycle === 2 &&
            [
              "retired",
              "retired-duplicate",
              "outside-retention",
              "metadata",
              "home-baseline",
              "both-baselines",
            ].includes(step.name)
          ) {
            // Literal first-cycle sequence schedule: 13 publications, floor 14.
            for (const [index, state] of states.entries()) {
              const homeCount = ["home-baseline", "both-baselines"].includes(
                step.name,
              )
                ? 1
                : 0;
              const awayCount = step.name === "both-baselines" ? 1 : 0;
              assert.equal(
                state.status.fields.homeScore.facts.minimumBirthSequence,
                14,
              );
              assert.equal(
                state.status.fields.awayScore.facts.minimumBirthSequence,
                14,
              );
              assert.equal(
                state.status.fields.homeScore.facts.activeCount,
                homeCount,
              );
              assert.equal(
                state.status.fields.awayScore.facts.activeCount,
                awayCount,
              );
              assert.equal(state.data.homeScore, 0);
              assert.equal(state.data.awayScore, 0);
              if (views[index] !== "scoreboard") {
                assert.equal(
                  state.status.fields.homeGoals.facts.minimumBirthSequence,
                  14,
                );
                assert.equal(
                  state.status.fields.awayGoals.facts.minimumBirthSequence,
                  14,
                );
                assert.deepEqual(
                  state.data.homeGoals,
                  homeCount
                    ? [
                        {
                          birthSequence: 16,
                          revision: 1,
                          payload: { kind: "baseline", cycle: 2, points: 0 },
                        },
                      ]
                    : [],
                );
                assert.deepEqual(
                  state.data.awayGoals,
                  awayCount
                    ? [
                        {
                          birthSequence: 17,
                          revision: 1,
                          payload: { kind: "baseline", cycle: 2, points: 0 },
                        },
                      ]
                    : [],
                );
              }
              assert.equal(
                state.data.match.cycle,
                ["retired", "retired-duplicate", "outside-retention"].includes(
                  step.name,
                )
                  ? 1
                  : 2,
              );
              const late = await lateSnapshot(
                service.baseUrl,
                views[index],
                "match-1",
              );
              assert.deepEqual(late.data, state.data);
              assert.deepEqual(late.status, state.status);
            }
            if (step.name === "metadata") {
              assert.equal(current.data.match.scoreWindowStart, 14);
              assert.equal(current.data.market.cycle, 1);
            }
            if (step.name === "outside-retention")
              assert.ok(
                receipts[0].targets?.every((t) =>
                  t.fields?.every((f) => f.reason === "factOutsideRetention"),
                ),
              );
          }
          if (step.name === "market-refreshed") {
            assert.equal(current.data.homeScore, 0);
            assert.equal(current.data.awayScore, 0);
            assert.equal(current.data.match.cycle, step.cycle);
            assert.equal(
              current.status.inputs["match-feed"].missingRanges.length,
              0,
            );
            assert.deepEqual(current.status.inputs.bookmaker.missingRanges, [
              { from: 2, through: 2, status: "confirmed" },
            ]);
          }
        },
      });
      await producer.done;
      assert.equal(producer.status.state, "complete");
      for (const [entity, home, away] of [
        ["match-2", 1, 1],
        ["match-3", 1, 2],
      ] as const) {
        for (const view of ["match-market", "scoreboard"]) {
          const state = await read(service.baseUrl, view, entity);
          assert.equal(state.data.homeScore, home);
          assert.equal(state.data.awayScore, away);
          assert.equal(state.data.match.cycle, 3);
        }
      }
    } finally {
      await producer?.close();
      await service.close();
    }
  },
);

test(
  "Bookmaker silence expires receipt age; reconnect alone leaves odds stale",
  { timeout: 45000 },
  async () => {
    const service = await startZooGlassSession({
      configuration: sportsConfiguration(),
    });
    let producer: Awaited<ReturnType<typeof startSportsProducer>> | undefined;
    let market: unknown;
    try {
      producer = await startSportsProducer(service.baseUrl, {
        cycles: 1,
        tickMs: 10,
        signal: service.signal,
        async onStep(step) {
          if (step.entityId !== "match-1") return;
          if (step.name === "finished") {
            const deadline = Date.now() + 18000;
            while (true) {
              const state = await read(service.baseUrl);
              if (state.status.fields.market.freshness === "stale") {
                market = state.data.market;
                break;
              }
              assert.ok(Date.now() < deadline, "market did not become stale");
              await delay(50);
            }
          }
          if (step.name === "bookmaker-reconnected") {
            const state = await read(service.baseUrl);
            assert.equal(state.status.fields.market.freshness, "stale");
            assert.deepEqual(state.data.market, market);
            assert.equal(state.data.match.period, "finished");
          }
          if (step.name === "market-refreshed") {
            const state = await read(service.baseUrl);
            assert.equal(state.status.fields.market.freshness, "fresh");
            assert.equal(state.data.homeScore, 0);
            assert.equal(state.data.awayScore, 0);
          }
        },
      });
      await producer.done;
    } finally {
      await producer?.close();
      await service.close();
    }
  },
);
