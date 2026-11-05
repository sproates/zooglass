import assert from "node:assert/strict";
import test from "node:test";
import { openScenarioSession } from "../src/execution/scenario-session.js";
import { startZooGlassSession } from "../src/service/zooglass-session.js";

test("the source step checks admission before the next step runs", async (t) => {
  const sources = [{ id: "feed", name: "Feed" }];
  const service = await startZooGlassSession({ sources, views: [] });
  t.after(() => service.close());
  const session = await openScenarioSession(
    { name: "Receipts", sources, clients: [], timeline: [], views: [] },
    service.baseUrl,
  );
  t.after(() => session.close());
  const initial = {
    kind: "source-event" as const,
    simulationTime: 0,
    sourceId: "feed",
    sourceName: "Feed",
    epoch: "run",
    entityId: "item",
    type: "reading",
    publicationSequence: 1,
    payload: { value: 10 },
  };
  await session.execute(initial);
  await session.execute(initial);
  const conflict = { ...initial, payload: { value: 20 } };
  await assert.rejects(
    session.execute(conflict),
    /received rejected \(identityConflict\)/,
  );
  await session.execute({ ...conflict, expectedRejection: "identityConflict" });
  await assert.rejects(
    session.execute({
      ...initial,
      publicationSequence: 2,
      expectedRejection: "identityConflict",
    }),
    /received applied/,
  );
});
