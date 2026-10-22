import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { playScenario } from "../../src/playback.js";
import { loadScenario } from "../../src/scenario.js";

const scenarioPath = fileURLToPath(
  new URL("../../scenarios/late-update.json", import.meta.url),
);

test("keeps arrival time separate from the older source timestamp", async () => {
  const scenario = await loadScenario(scenarioPath);
  const events = playScenario(scenario).filter(
    (entry) => entry.kind === "source-event",
  );
  const packedOrder = events.find((event) => event.type === "order.packed");
  const inventoryReservation = events.find(
    (event) => event.type === "inventory.reserved",
  );

  assert.ok(packedOrder);
  assert.ok(inventoryReservation);
  assert.ok(inventoryReservation.simulationTime > packedOrder.simulationTime);
  assert.ok(
    Number(inventoryReservation.payload.sourceTimestamp) <
      Number(packedOrder.payload.sourceTimestamp),
  );
});
