import assert from "node:assert/strict";
import test from "node:test";
import { playScenario } from "../src/scenario/playback.js";
import { parseScenario } from "../src/scenario/scenario.js";

test("plays events by simulation time and preserves declaration order for ties", () => {
  const scenario = parseScenario({
    name: "Out-of-order declarations",
    sources: [
      { id: "scores", name: "Score feed" },
      { id: "odds", name: "Odds feed" },
    ],
    clients: [],
    timeline: [
      {
        kind: "source-event",
        simulationTime: 20,
        sourceId: "odds",
        type: "odds.updated",
        entityId: "match-1",
        payload: { homeWin: 2 },
      },
      {
        kind: "source-event",
        simulationTime: 10,
        sourceId: "scores",
        type: "score.updated",
        entityId: "match-1",
        payload: { home: 0 },
      },
      {
        kind: "source-event",
        simulationTime: 10,
        sourceId: "odds",
        type: "odds.updated",
        entityId: "match-1",
        payload: { homeWin: 2.1 },
      },
    ],
  });

  assert.deepEqual(
    playScenario(scenario).map((entry) => [entry.kind, entry.simulationTime]),
    [
      ["source-event", 10],
      ["source-event", 10],
      ["source-event", 20],
    ],
  );
});

test("keeps declaration order for source events and client state changes at the same time", () => {
  const scenario = parseScenario({
    name: "A client changes state during a feed update",
    sources: [{ id: "scores", name: "Score feed" }],
    clients: [{ id: "viewer-1", name: "Viewer", initialState: "disconnected" }],
    timeline: [
      {
        kind: "client-state",
        simulationTime: 10,
        clientId: "viewer-1",
        state: "connecting",
      },
      {
        kind: "source-event",
        simulationTime: 10,
        sourceId: "scores",
        type: "score.updated",
        entityId: "match-1",
        payload: { home: 1 },
      },
    ],
  });

  assert.deepEqual(
    playScenario(scenario).map((entry) => entry.kind),
    ["client-initial-state", "client-state", "source-event"],
  );
});
