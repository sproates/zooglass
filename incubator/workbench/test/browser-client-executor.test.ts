import assert from "node:assert/strict";
import test from "node:test";
import { createBrowserClientExecutor } from "../src/browser-client-executor.js";

const state = {
  kind: "client-state" as const,
  simulationTime: 0,
  clientId: "rider-app",
  clientName: "Viewer",
  state: "connected" as const,
};
const check = {
  kind: "client-view-check" as const,
  simulationTime: 0,
  clientId: "rider-app",
  clientName: "Viewer",
  viewId: "live-map",
  entityId: "car-17",
  expected: { position: { sequence: 40 } },
};

test("browser executor sends only action arguments, waits for matching completion and rejects overlap", async () => {
  const sent: Record<string, unknown>[] = [];
  const control = createBrowserClientExecutor(
    "rider-app",
    new AbortController().signal,
    (message) => sent.push(message),
    () => {},
  );
  const running = control.executor.execute(state, new AbortController().signal);
  await assert.rejects(
    control.executor.execute(state, new AbortController().signal),
    /already running/,
  );
  assert.deepEqual(Object.keys(sent[0]).sort(), [
    "action",
    "commandId",
    "type",
  ]);
  control.receive({
    type: "completed",
    commandId: "stale",
    connectionGeneration: 0,
  });
  control.receive({
    type: "observation",
    event: "opened",
    connectionGeneration: 1,
    observationIndex: 1,
  });
  control.receive({
    type: "completed",
    commandId: sent[0].commandId,
    connectionGeneration: 1,
  });
  await running;
  const waiting = control.executor.execute(check, new AbortController().signal);
  assert.equal(
    sent.length,
    1,
    "Expected view data must not be sent to the browser.",
  );
  control.receive({
    type: "observation",
    event: "view-update",
    connectionGeneration: 1,
    observationIndex: 2,
    viewId: check.viewId,
    entityId: check.entityId,
    data: check.expected,
  });
  await waiting;
  await control.executor.close();
});

test("old-generation receipts cannot satisfy a current check; cancellation fails the action", async () => {
  const failures: string[] = [];
  const control = createBrowserClientExecutor(
    "rider-app",
    new AbortController().signal,
    () => {},
    (reason) => failures.push(reason),
  );
  control.receive({
    type: "observation",
    event: "opened",
    connectionGeneration: 1,
    observationIndex: 1,
  });
  control.receive({
    type: "observation",
    event: "opened",
    connectionGeneration: 2,
    observationIndex: 2,
  });
  control.receive({
    type: "observation",
    event: "view-update",
    connectionGeneration: 1,
    observationIndex: 3,
    viewId: check.viewId,
    entityId: check.entityId,
    data: check.expected,
  });
  const cancellation = new AbortController();
  const waiting = control.executor.execute(check, cancellation.signal);
  cancellation.abort(new Error("Cancelled check"));
  await assert.rejects(waiting);
  assert.equal(failures.length, 1);
  await control.executor.close();
});

test("browser receipt overflow fails rather than discarding evidence", async () => {
  const failures: string[] = [];
  const control = createBrowserClientExecutor(
    "rider-app",
    new AbortController().signal,
    () => {},
    (reason) => failures.push(reason),
  );
  control.receive({
    type: "observation",
    event: "opened",
    connectionGeneration: 1,
    observationIndex: 1,
  });
  for (let index = 2; index <= 258; index++)
    control.receive({
      type: "observation",
      event: "view-update",
      connectionGeneration: 1,
      observationIndex: index,
      viewId: check.viewId,
      entityId: check.entityId,
      data: check.expected,
    });
  assert.deepEqual(failures, ["Browser receipt buffer exhausted."]);
  await control.executor.close();
});

test(
  "reconnect discards buffered receipts and ignores late old-generation observations",
  { timeout: 3000 },
  async () => {
    const control = createBrowserClientExecutor(
      "rider-app",
      new AbortController().signal,
      () => {},
      () => {},
    );
    const observation = (event: string, generation: number, index: number) =>
      control.receive({
        type: "observation",
        event,
        connectionGeneration: generation,
        observationIndex: index,
        viewId: check.viewId,
        entityId: check.entityId,
        data: check.expected,
      });
    try {
      observation("opened", 1, 1);
      observation("view-update", 1, 2);
      observation("opened", 2, 3);
      observation("view-update", 1, 100);
      let completed = false;
      const waiting = control.executor.execute(
        check,
        new AbortController().signal,
      );
      void waiting.then(() => {
        completed = true;
      });
      await Promise.resolve();
      assert.equal(
        completed,
        false,
        "neither the buffered nor late old receipt satisfies the new check",
      );
      observation("view-update", 2, 4);
      await waiting;
      assert.equal(
        completed,
        true,
        "a stale high index must not suppress current observations",
      );
    } finally {
      await control.executor.close();
    }
  },
);
