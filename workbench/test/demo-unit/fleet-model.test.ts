import assert from "node:assert/strict";
import test from "node:test";
import {
  createFleetModel,
  parseManifest,
} from "../../../vehicle-tracker/dist/fleet/model.js";

const vehicles = [
  { id: "a", name: "Alpha" },
  { id: "b", name: "Bravo" },
];
const first = { sequence: 40, latitude: 36.1408, longitude: -5.3536 };

test("fleet selection retains independently received state and distinguishes empty from waiting", () => {
  const model = createFleetModel(vehicles);
  model.setConnection("connected");
  model.subscription("fleet-state", "a", "subscribed");
  model.subscription("received-journey", "a", "subscribed");
  model.receive("fleet-state", "a", { position: first });
  model.receive("received-journey", "a", { positions: [] });
  model.select("b");
  model.receive("fleet-state", "a", {
    position: first,
    operation: { sequence: 100, status: "available" },
  });

  assert.equal(model.selected, "b");
  assert.equal(model.get("fleet-state", "b").received, false);
  assert.deepEqual(model.get("received-journey", "a").positions, []);
  assert.match(model.status("received-journey", "a"), /empty snapshot/);
  assert.match(model.status("received-journey", "b"), /No snapshot/);
  assert.deepEqual(model.get("fleet-state", "a").position, first);
  model.select("a");
  assert.equal(model.get("fleet-state", "a").operation?.sequence, 100);
});

test("reconnection retains each pair until its own new snapshot arrives", () => {
  const model = createFleetModel(vehicles);
  model.setConnection("connected");
  for (const view of ["fleet-state", "received-journey"])
    model.subscription(view, "a", "subscribed");
  model.receive("fleet-state", "a", { position: first });
  model.receive("received-journey", "a", { positions: [first] });
  model.setConnection("disconnected");
  assert.match(
    model.status("fleet-state", "a"),
    /Last received · disconnected/,
  );
  assert.deepEqual(model.get("fleet-state", "a").position, first);

  model.setConnection("connected");
  for (const view of ["fleet-state", "received-journey"])
    model.subscription(view, "a", "subscribed");
  model.receive("fleet-state", "a", {
    operation: { sequence: 101, status: "returning" },
  });
  assert.equal(model.get("fleet-state", "a").position, undefined);
  assert.equal(model.status("fleet-state", "a"), "Latest snapshot received");
  assert.match(
    model.status("received-journey", "a"),
    /waiting for a fresh snapshot/,
  );
  model.receive("received-journey", "a", { positions: [] });
  assert.match(model.status("received-journey", "a"), /empty snapshot/);
});

test("invalid identities and snapshots cannot overwrite accepted fleet state", () => {
  const model = createFleetModel(vehicles);
  model.receive("fleet-state", "a", { position: first });
  assert.throws(
    () => model.receive("fleet-state", "unknown", { position: first }),
    /Unknown/,
  );
  assert.throws(() => model.receive("unknown", "a", {}), /Unknown/);
  assert.throws(() => model.select("unknown"), /Unknown/);
  assert.throws(
    () =>
      model.receive("fleet-state", "a", {
        position: { ...first, sequence: 42 },
        operation: { sequence: 1, status: "invented" },
      }),
    /Invalid/,
  );
  assert.deepEqual(model.get("fleet-state", "a").position, first);
  assert.throws(
    () => model.receive("received-journey", "a", { positions: [null] }),
    /Invalid/,
  );
  assert.equal(model.get("received-journey", "a").received, false);
  assert.throws(
    () => parseManifest({ vehicles: [vehicles[0], vehicles[0]] }),
    /duplicate/,
  );
  assert.throws(() => parseManifest({ vehicles: [] }), /must contain/);
  assert.deepEqual(
    parseManifest({ vehicles: [{ ...vehicles[0], position: first }] }),
    [vehicles[0]],
  );
});
