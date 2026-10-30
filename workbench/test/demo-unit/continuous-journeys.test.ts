import assert from "node:assert/strict";
import test from "node:test";
import {
  loadCars,
  journey,
  metres,
} from "../../src/demos/vehicle/continuous/journeys.js";
import { deliveryAt } from "../../src/demos/vehicle/continuous/delivery.js";
import { reportAge } from "../../../demos/vehicle-tracker/dist/driving/report-age.js";

test("six closed road journeys remain continuous across many laps", async () => {
  const cars = await loadCars();
  assert.equal(cars.length, 6);
  for (const car of cars) {
    assert.ok(!car.route.roads.includes("Main Street"));
    const path = journey(car);
    for (let second = 0; second < 10_000; second++) {
      assert.ok(
        metres(path.position(second), path.position(second + 1)) <=
          car.speed + 0.01,
      );
    }
    assert.ok(
      metres(path.position(0), path.position(path.length / car.speed)) < 0.01,
    );
  }
});

test("every car encounters all delivery problems while other cars still report", () => {
  for (let car = 0; car < 6; car++) {
    const deliveries = new Set(
      Array.from({ length: 360 }, (_, tick) => deliveryAt(tick, car)),
    );
    assert.deepEqual(
      deliveries,
      new Set(["normal", "delayed", "duplicate", "lost", "offline", "quiet"]),
    );
  }
  for (let tick = 0; tick < 360; tick++) {
    assert.ok(
      Array.from({ length: 6 }, (_, car) => deliveryAt(tick, car)).includes(
        "normal",
      ),
    );
  }
});

test("age reflects the accepted observation even after reconnect or duplicate delivery", () => {
  assert.equal(reportAge(1000, 8999, true).stale, false);
  assert.equal(reportAge(1000, 9000, true).stale, true);
  assert.equal(reportAge(1000, 2000, false).stale, true);
  assert.equal(reportAge(1000, 21000, true).text, "Last reported 20s ago");
  assert.equal(reportAge(20000, 21000, true).stale, false);
});
