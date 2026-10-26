import assert from "node:assert/strict";
import test from "node:test";
import { createBrowserClientExecutor } from "../../src/browser/browser-client-executor.js";
import { createVehicleFaults } from "../../src/demos/vehicle/vehicle-faults.js";

test("first recovery snapshot cannot be replaced by a later matching receipt", async () => {
  const control = createBrowserClientExecutor(
    "reader",
    new AbortController().signal,
    () => {},
    () => {},
  );
  let index = 0;
  const receive = (event: string, detail = {}) =>
    control.receive({
      type: "observation",
      event,
      connectionGeneration: 1,
      observationIndex: ++index,
      ...detail,
    });
  receive("opened");
  const faults = createVehicleFaults({
    runId: "run",
    clientId: "reader",
    publish() {},
    async controlDataConnection() {},
    observations: { ...control.observations, async wait() {} },
  } as unknown as Parameters<typeof createVehicleFaults>[0]);
  const entry = {
    kind: "data-connection-fault" as const,
    simulationTime: 0,
    clientId: "reader",
    clientName: "Reader",
  };
  await faults.execute(
    { ...entry, action: "break" },
    new AbortController().signal,
  );
  await faults.execute(
    { ...entry, action: "restore" },
    new AbortController().signal,
  );
  receive("subscribed", { viewId: "live-map", entityId: "car-17" });
  receive("view-update", {
    viewId: "live-map",
    entityId: "car-17",
    data: { position: { sequence: 42 } },
  });
  receive("view-update", {
    viewId: "live-map",
    entityId: "car-17",
    data: { position: { sequence: 43 } },
  });
  const check = {
    kind: "client-view-check" as const,
    simulationTime: 0,
    clientId: "reader",
    clientName: "Reader",
    viewId: "live-map",
    entityId: "car-17",
    expected: { position: { sequence: 43 } },
  };
  await control.executor.execute(check, new AbortController().signal); // An ordinary matching check would pass.
  assert.throws(() => faults.check(check), /First recovery snapshot/);
  await control.executor.close();
});
