import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadScenario, parseScenario } from "../../src/scenario/scenario.js";
import type { DemoState } from "../../src/control/demo-controller.js";
import {
  vehicleStepDescriptions,
  describeVehicleProgress,
} from "../../src/demos/vehicle/vehicle-step-description.js";

const scenario = await loadScenario(
  fileURLToPath(
    new URL("../../scenarios/vehicle-browser-recovery.json", import.meta.url),
  ),
);

const ready: DemoState = {
  phase: "ready",
  exploratory: false,
  interventions: 0,
  lastIntervention: "",
  skippedChecks: 0,
  playing: false,
  completed: 0,
  total: 1,
  detail: "Ready",
};

test("step descriptions distinguish late and duplicate sends from connection actions", () => {
  const descriptions = vehicleStepDescriptions(scenario);

  assert.match(descriptions[0], /^Send position 40/);
  assert.ok(
    descriptions.some((text) => text.startsWith("Send late position 41")),
  );
  assert.ok(
    descriptions.some((text) => text.startsWith("Send duplicate position 41")),
  );
  assert.ok(
    descriptions.some((text) => text.startsWith("Disconnect Vehicle viewer")),
  );
  assert.ok(
    descriptions.some((text) => text.startsWith("Reconnect Vehicle viewer")),
  );
});

test("progress describes the active cursor without claiming an outcome", () => {
  const descriptions = ["Send position 40.", "Send late position 41."];

  assert.match(
    describeVehicleProgress(ready, descriptions),
    /^Next scripted step: Send position 40/,
  );
  assert.match(
    describeVehicleProgress(
      { ...ready, phase: "stepping", completed: 1 },
      descriptions,
    ),
    /^Current step: Send late position 41/,
  );
  assert.match(
    describeVehicleProgress({ ...ready, exploratory: true }, descriptions),
    /checks are skipped/,
  );
  assert.match(
    describeVehicleProgress({ ...ready, phase: "failed" }, descriptions),
    /Run stopped/,
  );
  assert.match(
    describeVehicleProgress(
      { ...ready, phase: "complete", completed: 2 },
      descriptions,
    ),
    /No further scripted steps/,
  );
  assert.match(
    describeVehicleProgress({ ...ready, phase: "resetting" }, descriptions),
    /fresh run/,
  );
});

for (const completed of [1, 2]) {
  for (const lastIntervention of ["Disconnect viewer", "Reconnect viewer"]) {
    test(`progress describes ${lastIntervention} with ${completed} of 2 steps complete`, () => {
      const description = describeVehicleProgress(
        {
          ...ready,
          phase: "intervening",
          exploratory: true,
          interventions: 1,
          lastIntervention,
          completed,
          total: 2,
        },
        ["Send position 40.", "Send position 42."],
      );

      assert.equal(description, `Current action: ${lastIntervention}.`);
    });
  }
}

test("fleet descriptions keep ordering domains separate for entities and sources", async () => {
  const fleet = await loadScenario(
    fileURLToPath(
      new URL("../../scenarios/vehicle-fleet-contracts.json", import.meta.url),
    ),
  );
  const descriptions = vehicleStepDescriptions(fleet);
  assert.ok(
    descriptions.includes(
      "Send position 40 from Vehicle locations for car-28.",
    ),
  );
  assert.ok(
    descriptions.includes(
      "Send position 42 from Vehicle locations for car-17.",
    ),
  );
  assert.ok(
    descriptions.includes(
      "Send late operation 101 from Vehicle operations for car-28.",
    ),
  );
  assert.ok(
    descriptions.includes(
      "Send duplicate position 42 from Vehicle locations for car-17.",
    ),
  );
});

test("descriptions use envelope ordering across event types and isolate epochs", () => {
  const actions = [
    { publicationSequence: 1, sequence: 10 },
    { publicationSequence: 2, sequence: 10 },
    { publicationSequence: 3, sequence: 5 },
    { publicationSequence: 3, sequence: 99, type: "vehicle.operation.updated" },
    {
      publicationSequence: 2,
      sequence: 100,
      type: "vehicle.operation.updated",
    },
    { publicationSequence: 6, sequence: 100 },
    {
      publicationSequence: 5,
      sequence: 101,
      type: "vehicle.operation.updated",
    },
    { publicationSequence: 1, sequence: 10, epoch: "next" },
  ];
  const input = parseScenario({
    name: "Publication identity descriptions",
    sources: [{ id: "feed", name: "Feed" }],
    clients: [],
    views: [],
    timeline: actions.map((action, simulationTime) => ({
      kind: "source-event",
      simulationTime,
      sourceId: "feed",
      epoch: action.epoch ?? "run",
      publicationSequence: action.publicationSequence,
      type: action.type ?? "vehicle.location.updated",
      entityId: "car",
      payload: { sequence: action.sequence },
    })),
  });
  assert.deepEqual(vehicleStepDescriptions(input), [
    "Send position 1 from Feed for car.",
    "Send position 2 from Feed for car.",
    "Send position 3 from Feed for car.",
    "Send duplicate operation 3 from Feed for car.",
    "Send duplicate operation 2 from Feed for car.",
    "Send position 6 from Feed for car.",
    "Send late operation 5 from Feed for car.",
    "Send position 1 from Feed for car.",
  ]);
});
