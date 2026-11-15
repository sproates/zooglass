import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { startZooGlassSession } from "../src/service/zooglass-session.js";

const examples = resolve("../zooglass/docs/examples/configuration");
const run = promisify(execFile);
const verify = async (mode: string, baseUrl: string) => {
  const { stdout } = await run(
    process.execPath,
    [join(examples, "run-example.mjs"), mode, baseUrl],
    { timeout: 20_000 },
  );
  return JSON.parse(stdout);
};

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
