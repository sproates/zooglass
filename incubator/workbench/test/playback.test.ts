import assert from "node:assert/strict";
import test from "node:test";
import { playScenario } from "../src/playback.js";
import { parseScenario } from "../src/scenario.js";

test("plays events by simulation time and preserves declaration order for ties", () => {
  const scenario = parseScenario({
    name: "Out-of-order declarations",
    sources: [
      { id: "scores", name: "Score feed" },
      { id: "odds", name: "Odds feed" },
    ],
    events: [
      {
        simulationTime: 20,
        sourceId: "odds",
        type: "odds.updated",
        entityId: "match-1",
        payload: { homeWin: 2 },
      },
      {
        simulationTime: 10,
        sourceId: "scores",
        type: "score.updated",
        entityId: "match-1",
        payload: { home: 0 },
      },
      {
        simulationTime: 10,
        sourceId: "odds",
        type: "odds.updated",
        entityId: "match-1",
        payload: { homeWin: 2.1 },
      },
    ],
  });

  assert.deepEqual(
    playScenario(scenario).map(({ sourceId, simulationTime }) => [
      sourceId,
      simulationTime,
    ]),
    [
      ["scores", 10],
      ["odds", 10],
      ["odds", 20],
    ],
  );
});
