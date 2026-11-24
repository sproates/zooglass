import assert from "node:assert/strict";
import test from "node:test";
import { createHook } from "node:async_hooks";
import { startResources } from "../src/benchmark/resources.js";

test("resource collection never launches probes on the sender thread", async () => {
  let launches = 0;
  const hook = createHook({
    init(_id, type) {
      if (type === "PROCESSWRAP") launches++;
    },
  });
  hook.enable();
  try {
    const sampler = await startResources(process.pid);
    const samples = await sampler.stop();
    assert.ok(samples.length > 0);
    assert.equal(
      launches,
      0,
      "probe processes must be launched outside the sender thread",
    );
  } finally {
    hook.disable();
  }
});

test("sampler stop is shared and collected clocks/PIDs describe the caller", async () => {
  const before = performance.now();
  const sampler = await startResources(process.pid);
  const first = sampler.stop();
  assert.equal(sampler.stop(), first);
  const samples = (await first) as {
    atMs: number;
    client: { pid: number };
    service: { pid: number };
    clientEventLoop: { samples: number };
  }[];
  assert.ok(samples[0].atMs >= before && samples[0].atMs <= performance.now());
  assert.equal(samples[0].client.pid, process.pid);
  assert.equal(samples[0].service.pid, process.pid);
  assert.ok(samples[0].clientEventLoop.samples > 0);
});

test("worker failure is reported and cannot masquerade as complete sampling", async () => {
  const threads = await import("node:worker_threads");
  const { syncBuiltinESMExports } = await import("node:module");
  const original = threads.default.Worker;
  const owned: InstanceType<typeof original>[] = [];
  threads.default.Worker = class extends original {
    constructor(...args: ConstructorParameters<typeof original>) {
      super(...args);
      owned.push(this);
    }
  };
  syncBuiltinESMExports();
  try {
    const sampler = await startResources(process.pid);
    await owned[0].terminate();
    await assert.rejects(sampler.stop(), /Resource worker exited unexpectedly/);
  } finally {
    threads.default.Worker = original;
    syncBuiltinESMExports();
    await Promise.all(owned.map((worker) => worker.terminate()));
  }
});

test("failed external probe is explicit unavailability, not a fabricated reading", async () => {
  const javaHome = process.env.JAVA_HOME;
  process.env.JAVA_HOME = "/nonexistent-zooglass-diagnostic-java";
  try {
    const sampler = await startResources(process.pid);
    const samples = (await sampler.stop()) as {
      heap: { unavailable: string };
    }[];
    assert.match(samples[0].heap.unavailable, /ENOENT/);
  } finally {
    if (javaHome === undefined) delete process.env.JAVA_HOME;
    else process.env.JAVA_HOME = javaHome;
  }
});

test(
  "a probe ignoring graceful termination is killed before sampler completion",
  { skip: process.platform === "win32", timeout: 20000 },
  async () => {
    const { mkdtemp, mkdir, writeFile, readFile, rm } =
      await import("node:fs/promises");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const root = await mkdtemp(join(tmpdir(), "resource-probe-"));
    const pidFile = join(root, "probe.pid");
    await mkdir(join(root, "bin"));
    await writeFile(
      join(root, "bin/jstat"),
      `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nprocess.on('SIGTERM', () => {});\nsetInterval(() => {}, 1000);\n`,
      { mode: 0o755 },
    );
    const previous = process.env.JAVA_HOME;
    process.env.JAVA_HOME = root;
    try {
      const sampler = await startResources(process.pid);
      const records = (await sampler.stop()) as {
        heap: { unavailable: string };
      }[];
      assert.match(records[0].heap.unavailable, /Command failed/);
      const pid = Number(await readFile(pidFile, "utf8"));
      assert.ok(Number.isSafeInteger(pid) && pid > 0);
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    } finally {
      if (previous === undefined) delete process.env.JAVA_HOME;
      else process.env.JAVA_HOME = previous;
      try {
        const pid = Number(await readFile(pidFile, "utf8"));
        if (Number.isSafeInteger(pid) && pid > 0) process.kill(pid, "SIGKILL");
      } catch {
        /* Probe already reaped, or failed before startup. */
      }
      await rm(root, { recursive: true, force: true });
    }
  },
);
