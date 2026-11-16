import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startZooGlassSession } from "../src/service/zooglass-session.js";

import {
  examples,
  verifyExample as verify,
} from "./support/configuration-examples.js";

test("configuration guide orders example verifies mapping, required contributions, priority and retry", async () => {
  const service = await startZooGlassSession({
    runtimeConfigurationPath: join(examples, "orders-memory.json"),
  });
  try {
    const snapshot = await verify("orders", service.baseUrl);
    assert.equal(snapshot.viewId, "order-summary");
  } finally {
    await service.close();
  }
});

test("configuration guide fact example retains the actual result and receipt after SQLite restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "configuration-guide-"));
  const options = {
    runtimeConfigurationPath: join(examples, "sales-sqlite.json"),
    databasePath: join(directory, "state.sqlite"),
  };
  let service;
  try {
    service = await startZooGlassSession(options);
    const before = await verify("sales", service.baseUrl);
    await service.close();
    service = await startZooGlassSession(options);
    const after = await verify("sales-restart", service.baseUrl);
    assert.deepEqual(after.data, before.data);
    assert.equal(after.version, before.version);
  } finally {
    await service?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
