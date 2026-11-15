import assert from "node:assert/strict";
import test from "node:test";
import { frame } from "../../scenarios/timeline-order/observations.js";
import {
  exclusions,
  expectedReceipt,
  expectedState,
  parityStates,
  projectReceipt,
  projectState,
  selectedSends,
  sends,
  watermark,
  watermarkReceipt,
} from "../../scripts/order-parity-oracle.js";

test("Order service projection excludes only runtime clock/version fields", () => {
  const actual = frame(parityStates.confirmedGap, "order-summary");
  actual.version = 900;
  actual.status.fields.delivery.receivedAtMillis = 900000;
  actual.status.fields.inventory.receivedAtMillis = 900001;
  assert.deepEqual(
    projectState(actual),
    expectedState("confirmedGap", "order-summary"),
  );
  const changed = structuredClone(actual);
  (changed.data.delivery as { observedAt: number }).observedAt++;
  assert.notDeepEqual(
    projectState(changed),
    projectState(actual),
    "Payload time is business data, not excluded receipt time",
  );
  changed.data = actual.data;
  changed.status.fields.delivery.freshness = "stale";
  assert.notDeepEqual(
    projectState(changed),
    projectState(actual),
    "Freshness remains observable",
  );
  assert.equal(Object.keys(exclusions).length, 4);
});

test("Order parity explicitly preserves gate, priority, mapping and confirmed progress gap", () => {
  const waiting = expectedState("primary", "order-tracking");
  assert.deepEqual(waiting.data, {});
  assert.equal(waiting.status.publication, "waiting");
  assert.deepEqual(waiting.status.missingRequiredFields, ["inventory"]);
  const stale = expectedState("expired", "order-summary");
  assert.deepEqual(stale.provenance.delivery, {
    sourceId: "courier-primary",
    epoch: "run",
    sourceEntityId: "shipment-1",
  });
  assert.deepEqual(stale.publicationSequences.delivery, [1]);
  assert.equal(stale.status.fields.delivery.freshness, "stale");
  assert.deepEqual(stale.status.inputs.payments.missingRanges, [
    { from: 2, through: 2, status: "confirmed" },
  ]);
  assert.equal(stale.status.inputs.payments.watermarkThrough, 4);
  assert.equal(stale.status.inputs.payments.completeThrough, null);
  assert.equal(stale.status.inputs.payments.completeness, "incomplete");
  const refreshed = expectedState("refreshedPrimary", "order-summary");
  assert.equal(refreshed.status.fields.delivery.freshness, "fresh");
  assert.deepEqual(refreshed.publicationSequences.delivery, [2]);
  assert.deepEqual(
    refreshed.status.inputs.payments,
    stale.status.inputs.payments,
  );
  assert.deepEqual(expectedReceipt("p35-0").targets, [
    {
      viewId: "order-summary",
      entityId: null,
      status: "rejected",
      reason: "unknownEntityMapping",
      changedFields: [],
      fields: [],
    },
  ]);
});

test("scoped source and control inputs preserve authored receipt semantics", () => {
  assert.equal(selectedSends.length, 14);
  assert.equal(new Set(selectedSends).size, 14);
  assert.deepEqual(sends["p7-0"].body, sends["p4-0"].body);
  assert.equal(expectedReceipt("p7-0").status, "duplicate");
  assert.equal(expectedReceipt("p7-0").reason, "alreadyCommitted");
  assert.deepEqual(
    expectedReceipt("p7-0").targets,
    expectedReceipt("p4-0").targets,
  );
  assert.deepEqual(watermark.control, {
    sourceId: "payments",
    epoch: "run",
    sourceEntityId: "payment-1",
    throughSequence: 4,
  });
  assert.equal(watermarkReceipt.status, "committed");
  assert.deepEqual(watermarkReceipt.changedViews, ["order-summary"]);
  const original = { ...expectedReceipt("p4-0"), version: 4 };
  assert.deepEqual(
    projectReceipt({ ...original, version: 50 }),
    projectReceipt(original),
  );
  assert.notDeepEqual(
    projectReceipt({ ...original, status: "duplicate" }),
    projectReceipt(original),
  );
});
