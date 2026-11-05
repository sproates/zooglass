import assert from "node:assert/strict";
import test from "node:test";
import { parseScenario } from "../src/scenario/scenario.js";

function parseFault(changes: Record<string, unknown>) {
  return parseScenario({
    name: "Fault grammar",
    sources: [],
    clients: [{ id: "viewer", name: "Viewer", initialState: "connected" }],
    timeline: [
      {
        kind: "data-connection-fault",
        simulationTime: 0,
        clientId: "viewer",
        action: "break",
        ...changes,
      },
    ],
  }).timeline[0];
}

test("fault timeout accepts both inclusive boundaries and preserves omission", () => {
  for (const timeoutMs of [1, 30000]) {
    assert.deepEqual(parseFault({ timeoutMs }), {
      kind: "data-connection-fault",
      simulationTime: 0,
      clientId: "viewer",
      action: "break",
      timeoutMs,
    });
  }
  assert.equal(Object.hasOwn(parseFault({}), "timeoutMs"), false);
  assert.deepEqual(parseFault({ action: "restore" }), {
    kind: "data-connection-fault",
    simulationTime: 0,
    clientId: "viewer",
    action: "restore",
  });
});

test("fault timeout rejects wrong types, fractions and out-of-range values", () => {
  for (const timeoutMs of [null, "1", true, 0, -1, 1.5, 30001, NaN, Infinity]) {
    assert.throws(() => parseFault({ timeoutMs }), {
      message:
        "Fault timeoutMs must be 1–30000 ms and is allowed only on break.",
    });
  }
  assert.throws(
    () => parseFault({ action: "restore", timeoutMs: 1 }),
    /allowed only on break/,
  );
});

test("fault validation retains client-before-action-before-timeout error precedence", () => {
  assert.throws(
    () => parseFault({ clientId: "missing", action: "bad", timeoutMs: 0 }),
    { message: 'timeline[0] refers to unknown client "missing".' },
  );
  assert.throws(() => parseFault({ action: "bad", timeoutMs: 0 }), {
    message: "Data connection fault action must be break or restore.",
  });
});
