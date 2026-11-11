import assert from "node:assert/strict";
import { readFile, access, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { join, dirname } from "node:path";
import type { RuntimeConfiguration } from "../src/service/runtime-contract.js";
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

const configuredRuntime: RuntimeConfiguration = {
  contractVersion: 2,
  storage: "sqlite",
  maxStreams: 8,
  identityWindow: 16,
  maxHistoryEntries: 8,
  sources: [{ id: "warehouse", epoch: "run" }],
  views: [
    {
      id: "stock",
      fields: {
        inventory: {
          sourceId: "warehouse",
          type: "stock",
          mode: "latestBySequence",
          freshness: { mode: "receiptAge", staleAfterMillis: 15000 },
        },
      },
      publication: {
        mode: "requireContributions",
        fields: ["inventory"],
        maxPendingEntities: 6,
      },
    },
  ],
};

for (const callerOwned of [false, true]) {
  test(
    `configured session preserves policies and ${callerOwned ? "retains caller" : "removes session"} database`,
    processTestOptions,
    async (t) => {
      const fixture = await serviceFixture(t, "healthy");
      const databasePath = callerOwned
        ? join(fixture.directory, "retained.sqlite")
        : undefined;
      const session = await startZooGlassSession({
        serviceDirectory: fixture.directory,
        javaExecutable: fixture.javaExecutable,
        configuration: configuredRuntime,
        databasePath,
      });
      t.after(() => session.close());
      const started = await fixture.started();
      const configPath = fileURLToPath(started.config);
      assert.deepEqual(
        JSON.parse(await readFile(configPath, "utf8")),
        configuredRuntime,
      );
      assert.equal(
        started.database,
        databasePath ?? join(dirname(configPath), "state.sqlite"),
      );
      await writeFile(started.database!, "retained state");
      await session.close();
      await assert.rejects(access(configPath), { code: "ENOENT" });
      if (callerOwned) {
        assert.equal(
          await readFile(started.database!, "utf8"),
          "retained state",
        );
      } else {
        await assert.rejects(access(started.database!), { code: "ENOENT" });
      }
    },
  );
}

test("ambiguous configuration and relative database paths fail before startup", async () => {
  for (const options of [{ views }, { sources: [] }]) {
    await assert.rejects(
      startZooGlassSession({ configuration: configuredRuntime, ...options }),
      /not both/,
    );
  }
  await assert.rejects(
    startZooGlassSession({ databasePath: "relative.sqlite" }),
    /must be absolute/,
  );
});
