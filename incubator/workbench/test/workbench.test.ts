import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { playScenario } from "../src/playback.js";
import { loadScenario, parseScenario } from "../src/scenario.js";

const exampleScenarioPath = fileURLToPath(
  new URL("../scenarios/live-match.json", import.meta.url),
);

test("loads and plays the live match example", async () => {
  const scenario = await loadScenario(exampleScenarioPath);

  assert.equal(
    scenario.name,
    "A live match with independent score and odds feeds",
  );
  assert.deepEqual(
    playScenario(scenario).map((event) => event.simulationTime),
    [0, 250, 1200, 1350],
  );
});

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
