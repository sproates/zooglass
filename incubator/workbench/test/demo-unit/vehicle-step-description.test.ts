import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadScenario } from "../../src/scenario/scenario.js";
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
