import assert from "node:assert/strict";
import test from "node:test";
import { parseScenario } from "../src/scenario.js";

test("rejects events that refer to an unknown source", () => {
  assert.throws(
    () =>
      parseScenario({
        name: "Unknown source",
        sources: [{ id: "scores", name: "Score feed" }],
        clients: [],
        timeline: [
          {
            kind: "source-event",
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

test("rejects client state changes that refer to an unknown client", () => {
  assert.throws(
    () =>
      parseScenario({
        name: "Unknown client",
        sources: [],
        clients: [],
        timeline: [
          {
            kind: "client-state",
            simulationTime: 0,
            clientId: "missing",
            state: "connected",
          },
        ],
      }),
    /unknown client "missing"/,
  );
});

test("rejects unsupported client states", () => {
  assert.throws(
    () =>
      parseScenario({
        name: "Invalid client state",
        sources: [],
        clients: [
          { id: "viewer-1", name: "Viewer", initialState: "disconnected" },
        ],
        timeline: [
          {
            kind: "client-state",
            simulationTime: 0,
            clientId: "viewer-1",
            state: "lost",
          },
        ],
      }),
    /timeline\[0\]\.state to be a client state/,
  );
});
