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

test("preserves ordering for startup and runtime view definitions", () => {
  const latestBySequence = {
    mode: "latestBySequence",
    sequenceField: "sequence",
  };
  const scenario = parseScenario({
    name: "Ordered vehicle locations",
    sources: [{ id: "vehicle-feed", name: "Vehicle feed" }],
    clients: [],
    views: [
      {
        id: "live-map",
        fields: {
          position: [
            { sourceId: "vehicle-feed", type: "vehicle.location.updated" },
          ],
        },
        ordering: { position: latestBySequence },
      },
    ],
    timeline: [
      {
        kind: "view-definition",
        simulationTime: 0,
        id: "runtime-map",
        fields: {
          position: [
            { sourceId: "vehicle-feed", type: "vehicle.location.updated" },
          ],
        },
        ordering: { position: latestBySequence },
      },
    ],
  });

  assert.deepEqual(scenario.views[0]?.ordering, {
    position: latestBySequence,
  });

  const runtimeView = scenario.timeline.find(
    (entry) => entry.kind === "view-definition",
  );

  assert.deepEqual(runtimeView?.ordering, { position: latestBySequence });
});

test("rejects invalid ordering strategies and fields", () => {
  const view = {
    id: "live-map",
    fields: {
      position: [
        { sourceId: "vehicle-feed", type: "vehicle.location.updated" },
      ],
    },
  };

  const scenario = (ordering: unknown) =>
    parseScenario({
      name: "Invalid ordering",
      sources: [{ id: "vehicle-feed", name: "Vehicle feed" }],
      clients: [],
      views: [{ ...view, ordering }],
      timeline: [],
    });

  assert.throws(
    () =>
      scenario({ position: { mode: "arrival", sequenceField: "sequence" } }),
    /mode to be "latestBySequence" or "historyBySequence"/,
  );
  assert.throws(
    () =>
      scenario({
        history: { mode: "latestBySequence", sequenceField: "sequence" },
      }),
    /unknown field "history"/,
  );
  assert.throws(
    () =>
      scenario({ position: { mode: "latestBySequence", sequenceField: " " } }),
    /sequenceField to be a non-empty string/,
  );
});
