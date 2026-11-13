import assert from "node:assert/strict";
import test from "node:test";
import { sportsConfiguration } from "../../src/demos/sports/configuration.js";
import { startZooGlassSession } from "../../src/service/zooglass-session.js";
import { connectClient, closeClient } from "../../src/execution/sockets.js";
import {
  publishAndCheckReceipt,
  type SourcePublication,
} from "../../src/execution/publication-receipt.js";

test(
  "another Sports match and score-only policy view require configuration, not a new projection",
  { timeout: 30000 },
  async (t) => {
    const configuration = sportsConfiguration();
    configuration.views.push({
      id: "first-score",
      publication: { mode: "publishPartial" },
      entities: { "match-feed": { mode: "envelopeEntity" } },
      fields: {
        homeScore: {
          sourceId: "match-feed",
          type: "home.contribution",
          mode: "sumActiveFacts",
          property: "points",
          facts: {
            revision: "firstFact",
            maxRetainedFacts: 16,
            minimumBirthSequence: 1,
          },
          late: { mode: "acceptLate" },
        },
      },
    });
    const service = await startZooGlassSession({
      configuration,
      signal: t.signal,
    });
    let source: WebSocket | undefined;
    const read = async (view: string) => {
      const reply = await fetch(`${service.baseUrl}/views/${view}/match-4`, {
        signal: AbortSignal.any([t.signal, AbortSignal.timeout(3000)]),
      });
      assert.equal(reply.status, 200);
      return reply.json();
    };
    const publish = (
      publicationSequence: number,
      payload: object,
      fact: SourcePublication["fact"],
    ) =>
      publishAndCheckReceipt(
        source!,
        {
          sourceId: "match-feed",
          epoch: "run",
          entityId: "match-4",
          type: "home.contribution",
          publicationSequence,
          payload,
          fact,
        },
        service.signal,
      );
    try {
      source = await connectClient(
        service.baseUrl.replace("http:", "ws:") + "/events",
        service.signal,
        false,
      );
      await publish(
        1,
        { kind: "baseline", points: 0 },
        { birthSequence: 1, revision: 1, operation: "create" },
      );
      const goal = { kind: "goal", scorer: "Avery Lane", points: 1 };
      await publish(2, goal, {
        birthSequence: 2,
        revision: 1,
        operation: "create",
      });
      const corrected = { ...goal, scorer: "Riley Stone" };
      const revision = await publish(3, corrected, {
        birthSequence: 2,
        revision: 2,
        operation: "revise",
      });
      assert.equal(revision.status, "committed");
      for (const view of [
        "match-market",
        "scoreboard",
        "first-reported",
        "first-score",
      ]) {
        const snapshot = await read(view);
        assert.equal(snapshot.data.homeScore, 1);
        if (view === "match-market")
          assert.deepEqual(snapshot.data.homeGoals.at(-1).payload, corrected);
        if (view === "first-reported")
          assert.deepEqual(snapshot.data.homeGoals.at(-1).payload, goal);
        const target = revision.targets!.find(
          (target) => target.viewId === view,
        )!;
        assert.equal(target.entityId, "match-4");
        assert.ok(
          target.fields!.every((field) =>
            view.startsWith("first-")
              ? field.status === "rejected" && field.reason === "factImmutable"
              : field.status === "accepted",
          ),
        );
      }
      await publish(
        4,
        {},
        { birthSequence: 2, revision: 3, operation: "retract" },
      );
      assert.equal((await read("scoreboard")).data.homeScore, 0);
      assert.deepEqual((await read("first-score")).data, { homeScore: 1 });
      assert.equal((await read("first-reported")).data.homeScore, 1);
      const duplicate = await publish(
        4,
        {},
        { birthSequence: 2, revision: 3, operation: "retract" },
      );
      assert.equal(duplicate.status, "duplicate");
      assert.equal((await read("scoreboard")).data.homeScore, 0);
      assert.deepEqual((await read("first-score")).data, { homeScore: 1 });
    } finally {
      try {
        await closeClient(source);
      } finally {
        await service.close();
      }
    }
  },
);
