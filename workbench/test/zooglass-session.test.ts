import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { startZooGlassSession } from "../src/service/zooglass-session.js";
import { serviceFixture } from "./support/service-process.js";

const processTestOptions = {
  skip: process.platform === "win32",
  timeout: 10_000,
};

const views = [{ id: "position", fields: {} }];

test(
  "process close is idempotent and waits for forced termination before removing configuration",
  processTestOptions,
  async (t) => {
    const fixture = await serviceFixture(t, "stubborn");
    const session = await startZooGlassSession({
      serviceDirectory: fixture.directory,
      javaExecutable: fixture.javaExecutable,
      views,
      shutdownTimeoutMs: 50,
    });

    t.after(() => session.close());

    const { pid, config, requestedPort } = await fixture.started();
    assert.equal(
      requestedPort,
      0,
      "the child must bind its own available port",
    );

    assert.deepEqual(
      JSON.parse(await readFile(fileURLToPath(config), "utf8")),
      {
        contractVersion: 2,
        storage: "memory",
        maxStreams: 100_000,
        identityWindow: 10_000,
        maxHistoryEntries: 10_000,
        sources: [],
        views,
      },
    );
    await Promise.all([session.close(), session.close()]);

    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    await assert.rejects(access(fileURLToPath(config)), { code: "ENOENT" });
    assert.equal(session.signal.aborted, true);
  },
);

for (const mode of ["unhealthy", "exit"] as const) {
  test(
    `failed ${mode} startup removes process and configuration`,
    processTestOptions,
    async (t) => {
      const fixture = await serviceFixture(t, mode);

      await assert.rejects(
        startZooGlassSession({
          serviceDirectory: fixture.directory,
          javaExecutable: fixture.javaExecutable,
          views,
          startupTimeoutMs: 3_000,
        }),
        mode === "exit" ? /aborted|SIGTERM/ : /healthy/,
      );

      const { pid, config } = await fixture.started();

      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
      await assert.rejects(access(fileURLToPath(config)), { code: "ENOENT" });
    },
  );
}

test("missing preparation fails clearly and cancellation prevents startup", async () => {
  await assert.rejects(
    startZooGlassSession({
      serviceDirectory: "/nonexistent/workbench-service",
    }),
    /Run npm run prepare:service/,
  );
  await assert.rejects(
    startZooGlassSession({ signal: AbortSignal.abort(new Error("cancelled")) }),
    /cancelled/,
  );
});

test(
  "Java spawn errors clean up and reject promptly",
  processTestOptions,
  async (t) => {
    const fixture = await serviceFixture(t, "healthy");

    await assert.rejects(
      startZooGlassSession({
        serviceDirectory: fixture.directory,
        javaExecutable: "/nonexistent/java",
        views,
      }),
      /aborted|ENOENT/,
    );
  },
);

test(
  "explicit runtime configuration preserves bytes and rejects generated configuration",
  processTestOptions,
  async (t) => {
    const fixture = await serviceFixture(t, "healthy");
    const runtimeConfigurationPath = fileURLToPath(
      new URL("../scenarios/timeline-fleet/runtime.json", import.meta.url),
    );
    const session = await startZooGlassSession({
      serviceDirectory: fixture.directory,
      javaExecutable: fixture.javaExecutable,
      runtimeConfigurationPath,
    });
    t.after(() => session.close());
    const { config } = await fixture.started();
    assert.deepEqual(
      await readFile(fileURLToPath(config)),
      await readFile(runtimeConfigurationPath),
    );
    await session.close();
    await assert.rejects(access(fileURLToPath(config)), { code: "ENOENT" });
    for (const generated of [
      { views },
      { sources: [] },
      { protectedAccess: {} },
    ]) {
      await assert.rejects(
        startZooGlassSession({
          runtimeConfigurationPath,
          ...generated,
        } as Parameters<typeof startZooGlassSession>[0]),
        /cannot be combined/,
      );
    }
    await assert.rejects(
      startZooGlassSession({
        runtimeConfigurationPath: "/nonexistent/runtime.json",
        serviceDirectory: fixture.directory,
        javaExecutable: fixture.javaExecutable,
      }),
      { code: "ENOENT" },
    );
  },
);
