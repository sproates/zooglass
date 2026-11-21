import assert from "node:assert/strict";
import test from "node:test";
import { validateDecisionEffects } from "../../src/timeline/bridge-decisions.js";
import type { Response } from "../../src/timeline/host-protocol.js";

test("bridge requires one opted-in decision and receipt on the ingress session", () => {
  const response: Response = {
    turnId: 1,
    runtimeGeneration: 1,
    timeMs: 0,
    pendingTasks: 0,
    heldFrames: 0,
    effects: [
      { kind: "receipt", session: "source-1", wire: "{}" },
      { kind: "publication-decision", session: "source-1", wire: "{}" },
    ],
  };
  const operation = { op: "ingress", session: "source-1" };
  assert.equal(validateDecisionEffects(response, operation, true), true);
  assert.throws(
    () => validateDecisionEffects(response, operation, false),
    /Unexpected/,
  );
  assert.throws(
    () => validateDecisionEffects(response, { op: "observe" }, true),
    /Unexpected/,
  );
  for (const effects of [
    response.effects.slice(0, 1),
    response.effects.slice(1),
    [...response.effects, response.effects[1]],
    response.effects.map((effect) => ({ ...effect, session: "other" })),
  ])
    assert.throws(
      () => validateDecisionEffects({ ...response, effects }, operation, true),
      /one receipt and decision/,
    );
  assert.equal(
    validateDecisionEffects(
      { ...response, effects: [] },
      { op: "initialize-document", publicationDecisions: true },
      false,
    ),
    true,
  );
  assert.equal(
    validateDecisionEffects(
      { ...response, effects: [] },
      { op: "initialize-document" },
      false,
    ),
    false,
  );
});
