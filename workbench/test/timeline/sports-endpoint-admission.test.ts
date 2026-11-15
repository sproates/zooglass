import assert from "node:assert/strict";
import test from "node:test";
import { parseTimelineDocument } from "../../src/timeline/contract.js";
import { retirementEnvelope } from "../../src/timeline/control-contract.js";
import { parseJson } from "../../src/timeline/json.js";
import { orderDocument, watermark } from "./order-document-fixture.js";
import { retirementAck, sportsDocument } from "./sports-document-fixture.js";

const parse = (value: ReturnType<typeof sportsDocument>) => {
  value.runtime.sha256 = "a".repeat(64);
  return parseTimelineDocument(JSON.stringify(value));
};

test("Order control assertions cannot import Sports retirement acknowledgements", () => {
  for (const profile of ["sqlite-order-v1", "sqlite-order-restart-v1"]) {
    const doc = orderDocument();
    doc.runtime.profile = profile;
    doc.assertions[0].expected = [retirementAck()];
    assert.throws(
      () => parse(doc),
      /acknowledgement kind must match its actor endpoint/,
    );
  }
});

test("Sports assertion envelopes follow each actor endpoint even without sends", () => {
  for (const role of ["progress", "retirement"]) {
    const doc = sportsDocument();
    doc.actors[0].role = role;
    doc.actions = [doc.actions[0]];
    doc.assertions[0].expected = [
      role === "progress" ? watermark() : retirementAck(),
    ];
    assert.doesNotThrow(() => parse(doc));
    doc.assertions[0].expected = [
      role === "progress" ? retirementAck() : watermark(),
    ];
    assert.throws(
      () => parse(doc),
      /acknowledgement kind must match its actor endpoint/,
    );
    doc.assertions[0].expected = [];
    assert.doesNotThrow(() => parse(doc));
  }
});

test("retirement sum overflow remains a complete semantic rejection", () => {
  const rejection = {
    ...retirementAck(),
    status: "rejected",
    reason: "numericRange",
    version: 3,
    floors: {},
    changedViews: [],
  };
  const doc = sportsDocument();
  doc.assertions[0].expected = [rejection];
  assert.doesNotThrow(() => parse(doc));
  assert.doesNotThrow(() =>
    retirementEnvelope(parseJson(JSON.stringify(rejection)), "ack"),
  );
  for (const patch of [
    { floors: { awayScore: 5, homeScore: 5 } },
    { changedViews: ["scoreboard"] },
  ])
    assert.throws(
      () =>
        retirementEnvelope(
          parseJson(JSON.stringify({ ...rejection, ...patch })),
          "ack",
        ),
      /rejected retirement cannot change floors or views/,
    );
});
