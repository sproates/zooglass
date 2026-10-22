import assert from "node:assert/strict";
import test from "node:test";
import { parseScenario } from "../src/scenario.js";

test("rejects events that refer to an unknown source", () => {
  assert.throws(
    () =>
      parseScenario({
        name: "Unknown source",
        sources: [{ id: "scores", name: "Score feed" }],
        events: [
          {
            simulationTime: 0,
            sourceId: "missing",
            type: "score.updated",
            entityId: "match-1",
            payload: {},
          },
        ],
      }),
    /unknown source "missing"/,
  );
});
