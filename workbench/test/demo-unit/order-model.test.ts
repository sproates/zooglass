import assert from "node:assert/strict";
import test from "node:test";
import {
  OrderModel,
  escape,
  type ViewSnapshot,
} from "../../../demos/order-tracker/src/model.js";

test("Order replaces whole snapshots, including lower-version reconnect baselines and empty waiting data", () => {
  const model = new OrderModel();
  const snapshot: ViewSnapshot = {
    viewId: "order-tracking",
    entityId: "order-1",
    version: 9,
    data: { order: { cycle: 1, status: "accepted", observedAt: 1 } },
    provenance: {
      order: { sourceId: "orders", epoch: "run", sourceEntityId: "order-1" },
    },
    publicationSequences: { order: [1] },
    status: {
      publication: "ready",
      missingFields: [],
      missingRequiredFields: [],
      fields: {},
      inputs: {},
    },
  };
  model.accept(snapshot);
  model.connected = true;
  assert.equal(model.saved("order-tracking", "order-1"), false);
  model.beginConnection();
  assert.equal(model.saved("order-tracking", "order-1"), true);
  const baseline = {
    ...snapshot,
    version: 0,
    data: {},
    provenance: {},
    publicationSequences: {},
    status: {
      ...snapshot.status,
      publication: "waiting",
      missingRequiredFields: ["inventory"],
    },
  };
  model.accept(baseline);
  assert.deepEqual(model.get("order-tracking", "order-1"), baseline);
  assert.equal(model.snapshots.size, 1);
  assert.throws(
    () => model.accept({ ...baseline, entityId: "unexpected" }),
    /identity/,
  );
  assert.equal(
    escape('<img src=x onerror="x">'),
    "&lt;img src=x onerror=&quot;x&quot;&gt;",
  );
});
