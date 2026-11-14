import assert from "node:assert/strict";
import test from "node:test";
import {
  retirementEnvelope,
  controlRequestMatches,
} from "../../src/timeline/control-contract.js";
import { parseJson } from "../../src/timeline/json.js";
import { object } from "../../src/timeline/validation.js";
import { decodeHandshake } from "../../src/timeline/host-protocol.js";
import { retirement, retirementAck } from "./sports-document-fixture.js";
const json = (value: unknown) => parseJson(JSON.stringify(value));

test("retirement evidence validates every floor, exact long version, sorted fields and status relationship", () => {
  assert.doesNotThrow(() => retirementEnvelope(json(retirementAck()), "ack"));
  assert.doesNotThrow(() =>
    retirementEnvelope(
      parseJson(
        JSON.stringify(retirementAck()).replace(
          '"version":1',
          '"version":9223372036854775807',
        ),
      ),
      "ack",
    ),
  );
  for (const patch of [
    { status: "failed", reason: "processingFailure" },
    { status: "unchanged" },
    { reason: "sqlite" },
    { version: 0 },
    { floors: { homeScore: 5 } },
    { floors: { homeScore: 6, awayScore: 5 } },
    { changedViews: ["scoreboard", "first-reported"] },
    { control: retirement },
    { control: { ...retirement, fields: ["homeScore", "homeScore"] } },
  ])
    assert.throws(() =>
      retirementEnvelope(json({ ...retirementAck(), ...patch }), "ack"),
    );
  const invalid = {
    kind: "factRetirement",
    status: "rejected",
    reason: "invalidFactRetirement",
    control: null,
    version: null,
    floors: {},
    changedViews: [],
  };
  assert.doesNotThrow(() => retirementEnvelope(json(invalid), "ack"));
  assert.throws(() =>
    retirementEnvelope(json({ ...invalid, version: 0 }), "ack"),
  );
  assert.equal(
    controlRequestMatches(
      object(json(retirement), "request"),
      object(json(retirementAck()), "ack"),
    ),
    true,
  );
  assert.equal(
    controlRequestMatches(
      object(json({ ...retirement, entityId: "different" }), "request"),
      object(json(retirementAck()), "ack"),
    ),
    false,
  );
});

test("Sports capability cannot be advertised by a legacy or non-SQLite host", () => {
  const base = {
    protocol: 2,
    fixture: "timeline-proof-v1",
    artifact: "a".repeat(64),
    frameCap: 16777216,
    storage: ["memory", "sqlite"],
    protectedAccess: false,
    memoryLifecycle: 1,
    sqliteLifecycle: 1,
    sqliteSports: 1,
    documentFormats: [],
    environment: { sqliteVersion: "3" },
  };
  assert.doesNotThrow(() => decodeHandshake(base));
  for (const patch of [
    { protocol: 1 },
    { sqliteLifecycle: undefined },
    { sqliteSports: 2 },
  ])
    assert.throws(() => decodeHandshake({ ...base, ...patch }), /sqliteSports/);
});
