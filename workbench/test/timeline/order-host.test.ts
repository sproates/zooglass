import assert from "node:assert/strict";
import test from "node:test";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Bridge } from "../../src/timeline/bridge.js";
import { parseTimelineDocument } from "../../src/timeline/contract.js";
import {
  decodeHandshake,
  decodeResponse,
} from "../../src/timeline/host-protocol.js";

const jar = fileURLToPath(
  new URL(
    "../../../zooglass/simulation-host/target/zooglass-simulation.jar",
    import.meta.url,
  ),
);
const config = await readFile(
  new URL(
    "../../../zooglass/simulation-host/src/test/resources/order-runtime.json",
    import.meta.url,
  ),
  "utf8",
);
async function host() {
  const directory = await mkdtemp(join(tmpdir(), "timeline-order-host-"));
  const opened = await Bridge.open(jar, 0, 0, {
    runtimeGeneration: 1,
    startTimeMs: 0,
    firstTurnId: 0,
  });
  try {
    assert.equal(opened.bridge.sqliteOrder, 1);
    await opened.bridge.command(0, {
      op: "initialize-document",
      wire: config,
      profile: "sqlite-order-v1",
      epochMillis: 1000000,
      database: join(directory, "state.db"),
    });
    return {
      directory,
      bridge: opened.bridge,
      async close() {
        await opened.bridge.close();
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await opened.bridge.close();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

test("prepared Order host returns complete durable control receipts without document admission", async () => {
  const run = await host();
  try {
    await run.bridge.command(0, {
      op: "connect",
      role: "progress",
      session: "progress-1",
    });
    const command = {
      op: "progress",
      session: "progress-1",
      wire: JSON.stringify({
        sourceId: "orders",
        epoch: "run",
        sourceEntityId: "order-1",
        throughSequence: 3,
      }),
    };
    const first = await run.bridge.command(0, command);
    const control = first.effects.find((e) => e.kind === "control-receipt");
    assert.equal(control?.kind, "control-receipt");
    if (control?.kind !== "control-receipt")
      throw new Error("Missing control receipt");
    assert.deepEqual(JSON.parse(control.wire), {
      kind: "watermark",
      status: "committed",
      reason: "sqlite",
      stream: { sourceId: "orders", epoch: "run", sourceEntityId: "order-1" },
      throughSequence: 3,
      version: 1,
      changedViews: ["order-summary", "order-tracking"],
    });
    const second = await run.bridge.command(0, command);
    assert.equal(second.effects.length, 1);
    const duplicate = second.effects[0];
    assert.equal(duplicate.kind, "control-receipt");
    if (duplicate.kind !== "control-receipt")
      throw new Error("Missing duplicate");
    assert.deepEqual(JSON.parse(duplicate.wire), {
      ...JSON.parse(control.wire),
      status: "duplicate",
      reason: "alreadyCommitted",
      changedViews: [],
    });
    await run.bridge.command(0, { op: "shutdown" });
  } finally {
    await run.close();
  }
  const fixture = JSON.parse(
    await readFile(
      new URL("../../scenarios/timeline-fleet/scenario.json", import.meta.url),
      "utf8",
    ),
  );
  fixture.runtime.profile = "sqlite-order-v1";
  fixture.runtime.storage = "sqlite";
  assert.throws(
    () => parseTimelineDocument(JSON.stringify(fixture)),
    /runtime.profile/,
  );
});

test("progress endpoint rejects source and client sessions", async () => {
  for (const role of ["source", "client"]) {
    const run = await host();
    try {
      await run.bridge.command(0, { op: "connect", role, session: "wrong" });
      await assert.rejects(
        run.bridge.command(0, { op: "progress", session: "wrong", wire: "{}" }),
      );
    } finally {
      await run.close();
    }
  }
});

test("control capability and response are protocol-two-only", () => {
  const handshake = {
    protocol: 2,
    fixture: "timeline-proof-v1",
    artifact: "a".repeat(64),
    frameCap: 16777216,
    storage: ["memory", "sqlite"],
    protectedAccess: false,
    memoryLifecycle: 1,
    sqliteLifecycle: 1,
    sqliteOrder: 1,
    documentFormats: [],
    environment: { sqliteVersion: "3" },
  };
  assert.deepEqual(decodeHandshake(handshake), handshake);
  assert.throws(
    () => decodeHandshake({ ...handshake, protocol: 1 }),
    /protocol 2/,
  );
  assert.throws(
    () => decodeHandshake({ ...handshake, sqliteOrder: 2 }),
    /sqliteOrder/,
  );
  assert.throws(
    () => decodeHandshake({ ...handshake, sqliteLifecycle: undefined }),
    /sqliteOrder/,
  );
  const response = {
    turnId: 0,
    runtimeGeneration: 1,
    timeMs: 0,
    monotonicMs: 0,
    wallMillis: 0,
    pendingTasks: 0,
    heldFrames: 0,
    effects: [{ kind: "control-receipt", session: "p", wire: "{}" }],
  };
  assert.deepEqual(decodeResponse(response, 2), response);
  assert.throws(() => decodeResponse(response, 1), /protocol 2/);
});

test("Order host rejects wall adjustment and publication on progress sessions", async () => {
  for (const operation of [
    { op: "wall-clock-set", wallMillis: 1000001 },
    { op: "ingress", session: "p", wire: "{}" },
  ]) {
    const run = await host();
    try {
      await run.bridge.command(0, {
        op: "connect",
        role: "progress",
        session: "p",
      });
      await assert.rejects(run.bridge.command(0, operation));
    } finally {
      await run.close();
    }
  }
});

test("existing document profiles cannot open a progress session", async () => {
  const opened = await Bridge.open(jar, 0, 0, {
    runtimeGeneration: 1,
    startTimeMs: 0,
    firstTurnId: 0,
  });
  try {
    const wire = await readFile(
      new URL("../../scenarios/timeline-fleet/runtime.json", import.meta.url),
      "utf8",
    );
    await opened.bridge.command(0, {
      op: "initialize-document",
      wire,
      profile: "memory-sequence-fleet-v1",
      epochMillis: 1000000,
    });
    await assert.rejects(
      opened.bridge.command(0, {
        op: "connect",
        role: "progress",
        session: "p",
      }),
      /Progress requires the Order profile/,
    );
  } finally {
    await opened.bridge.close();
  }
});
