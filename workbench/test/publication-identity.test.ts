import assert from "node:assert/strict";
import test from "node:test";
import { parseScenario } from "../src/scenario/scenario.js";

const event = {
  kind: "source-event",
  simulationTime: 0,
  sourceId: "feed",
  type: "reading",
  entityId: "item",
  epoch: "run",
  publicationSequence: 7,
  payload: { sequence: "application data" },
};
const scenario = (entry: unknown) => ({
  name: "Publication identity",
  sources: [{ id: "feed", name: "Feed" }],
  clients: [],
  views: [],
  timeline: [entry],
});

test("scenario publications retain explicit identities independently of payload fields", () => {
  assert.deepEqual(parseScenario(scenario(event)).timeline, [event]);
  assert.deepEqual(
    parseScenario(scenario({ ...event, payload: {} })).timeline,
    [{ ...event, payload: {} }],
  );
});

test("scenario parsing rejects missing epochs and non-positive or unsafe identities", () => {
  for (const epoch of [undefined, null, "", " ", 1]) {
    assert.throws(() => parseScenario(scenario({ ...event, epoch })), /epoch/);
  }
  for (const publicationSequence of [
    undefined,
    null,
    0,
    -1,
    1.5,
    "7",
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    assert.throws(
      () => parseScenario(scenario({ ...event, publicationSequence })),
      /publicationSequence/,
    );
  }
});
