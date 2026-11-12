import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { sportsConfiguration } from "../../src/demos/sports/configuration.js";
import { startSportsProducer } from "../../src/demos/sports/producer.js";
import { sportsTimeline } from "../../src/demos/sports/timeline.js";
import { startZooGlassSession } from "../../src/service/zooglass-session.js";

test(
  "forty Sports cycles bound retained facts, tombstones, progress and identities",
  { timeout: 120000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "sports-bounds-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const databasePath = join(directory, "state.sqlite");
    const service = await startZooGlassSession({
      configuration: sportsConfiguration(),
      databasePath,
      signal: t.signal,
    });
    let producer: Awaited<ReturnType<typeof startSportsProducer>> | undefined;
    try {
      producer = await startSportsProducer(service.baseUrl, {
        cycles: 40,
        tickMs: 10,
        signal: service.signal,
        async onStep(step) {
          assert.ok(step.actions.length <= 2);
          if (step.name !== "market-refreshed") return;
          const response = await fetch(
            `${service.baseUrl}/views/match-market/${step.entityId}`,
          );
          const state = await response.json();
          assert.equal(state.data.match.cycle, step.cycle);
          for (const field of [
            "homeGoals",
            "awayGoals",
            "homeScore",
            "awayScore",
          ]) {
            assert.ok(state.status.fields[field].facts.retainedCount <= 3);
            assert.ok(state.status.fields[field].facts.activeCount <= 3);
          }
          for (const source of ["match-feed", "bookmaker"]) {
            const progress = state.status.inputs[source];
            assert.ok(progress.missingRanges.length <= 1);
            assert.equal(progress.sourceContractViolated, false);
            if (step.cycle === 40) assert.ok(progress.admissionFloor > 1);
          }
          if (step.cycle === 40)
            assert.deepEqual(state.status.inputs.bookmaker.missingRanges, [
              { from: 2, through: 2, status: "expired" },
            ]);
        },
      });
      await producer.done;
      await service.close();
      const database = new DatabaseSync(databasePath, { readOnly: true });
      try {
        const views = database
          .prepare("SELECT view, entity, state FROM views")
          .all();
        assert.equal(views.length, 9);
        assert.equal(new Set(views.map((row) => row.entity)).size, 3);
        for (const row of views) {
          assert.match(String(row.entity), /^match-[1-3]$/);
          const state = JSON.parse(String(row.state));
          assert.equal(
            Object.keys(state.facts).length,
            row.view === "scoreboard" ? 2 : 4,
          );
          for (const facts of Object.values(state.facts)) {
            // Serialized FactState carries each birth once, including tombstones.
            const retained = facts as {
              floor: number;
              present: boolean;
              records: object;
            };
            const births = Object.keys(retained.records).map(Number);
            assert.equal(retained.present, true);
            assert.ok(births.length >= 1 && births.length <= 3);
            assert.ok(births.every((birth) => birth >= retained.floor));
          }
        }
        const streams = database.prepare("SELECT state FROM streams").all();
        assert.equal(streams.length, 6);
        for (const row of streams) {
          const state = JSON.parse(String(row.state));
          assert.equal(Object.keys(state.receipts).length, 128);
          assert.ok(state.progress.received.length <= 2);
        }
      } finally {
        database.close();
      }
    } finally {
      await producer?.close();
      await service.close();
    }
  },
);

test("lazy schedule preserves exact retries and allocates identities across event types", () => {
  const first = [...sportsTimeline(1)].filter(
    (step) => step.entityId === "match-1",
  );
  const event = (name: string) => {
    const action = first.find((step) => step.name === name)!.actions[0];
    assert.equal(action.kind, "publish");
    return action.event;
  };
  assert.deepEqual(
    [
      "metadata",
      "home-baseline",
      "both-baselines",
      "first-goal",
      "unknown-fact",
      "delayed-create",
      "corrected-scorer",
      "withdrawal",
      "obsolete-revision",
      "duplicate",
    ].map((name) => event(name).publicationSequence),
    [1, 2, 3, 4, 6, 5, 6, 8, 7, 8],
  );
  const { expectedRejection, ...early } = event("unknown-fact");
  assert.equal(expectedRejection, "unknownFact");
  assert.deepEqual(early, event("corrected-scorer"));
  assert.deepEqual(event("withdrawal"), event("duplicate"));
});
