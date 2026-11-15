import assert from "node:assert/strict";
import { readFile, access, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { join, dirname } from "node:path";
import type { RuntimeConfiguration } from "../src/service/runtime-contract.js";
import {
  startZooGlassSession,
  type ZooGlassSessionOptions,
} from "../src/service/zooglass-session.js";
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

test(
  "explicit runtime configuration preserves bytes",
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
  },
);

test("configuration ambiguity rejects before reading files or preparing a service", async () => {
  const runtimeConfigurationPath = "/nonexistent/runtime.json";
  const alternatives: ZooGlassSessionOptions[] = [
    { configuration: configuredRuntime, views },
    { configuration: configuredRuntime, sources: [] },
    { runtimeConfigurationPath, configuration: configuredRuntime },
    { runtimeConfigurationPath, views },
    { runtimeConfigurationPath, sources: [] },
    {
      runtimeConfigurationPath,
      protectedAccess: {
        keyStore: "unused",
        keyStorePassword: "unused",
        trustStore: "unused",
        trustStorePassword: "unused",
        tenant: "unused",
        policyUrl: "https://unused.invalid",
        serviceToken: "unused",
        origin: "https://unused.invalid",
        operatorPort: 1,
        operatorToken: "unused",
      },
    },
  ];
  for (const options of alternatives) {
    await assert.rejects(
      startZooGlassSession({
        serviceDirectory: "/nonexistent/workbench-service",
        javaExecutable: "/nonexistent/java",
        ...options,
      }),
      /not both|cannot be combined/,
    );
  }
  await assert.rejects(
    startZooGlassSession({ databasePath: "relative.sqlite" }),
    /must be absolute/,
  );
  await assert.rejects(
    startZooGlassSession({
      serviceDirectory: "/nonexistent/workbench-service",
      javaExecutable: "/nonexistent/java",
      runtimeConfigurationPath,
    }),
    { code: "ENOENT", path: runtimeConfigurationPath },
  );
});

for (const form of ["typed-owned", "typed-caller", "file-caller"] as const) {
  test(
    `failed startup preserves database ownership for ${form}`,
    processTestOptions,
    async (t) => {
      const fixture = await serviceFixture(t, "database-exit");
      const callerOwned = form !== "typed-owned";
      const databasePath = callerOwned
        ? join(fixture.directory, "retained database.sqlite")
        : undefined;
      if (databasePath)
        await writeFile(databasePath, "previous committed state");
      const runtimeConfigurationPath = join(fixture.directory, "source.json");
      const wire = JSON.stringify(configuredRuntime, null, 3) + "\n";
      await writeFile(runtimeConfigurationPath, wire);

      await assert.rejects(
        startZooGlassSession({
          serviceDirectory: fixture.directory,
          javaExecutable: fixture.javaExecutable,
          ...(form === "file-caller"
            ? { runtimeConfigurationPath }
            : { configuration: configuredRuntime }),
          databasePath,
          startupTimeoutMs: 3_000,
        }),
        /aborted|SIGTERM/,
      );
      const started = await fixture.started();
      assert.equal(
        started.databaseExists,
        true,
        "startup must have reached a real database file",
      );
      assert.throws(() => process.kill(started.pid, 0), { code: "ESRCH" });
      await assert.rejects(access(dirname(fileURLToPath(started.config))), {
        code: "ENOENT",
      });
      if (databasePath) {
        assert.equal(started.database, databasePath);
        assert.equal(
          await readFile(databasePath, "utf8"),
          "previous committed state",
        );
      } else {
        assert.equal(
          started.database,
          join(dirname(fileURLToPath(started.config)), "state.sqlite"),
        );
        await assert.rejects(access(started.database!), { code: "ENOENT" });
      }
      assert.equal(await readFile(runtimeConfigurationPath, "utf8"), wire);
    },
  );
}

test(
  "exact SQLite file and caller database survive normal close without rewriting input",
  processTestOptions,
  async (t) => {
    const fixture = await serviceFixture(t, "healthy");
    const runtimeConfigurationPath = join(fixture.directory, "source.json");
    const wire = JSON.stringify(configuredRuntime, null, 3) + "\n";
    const databasePath = join(fixture.directory, "caller database.sqlite");
    await writeFile(runtimeConfigurationPath, wire);
    await writeFile(databasePath, "previous committed state");
    const session = await startZooGlassSession({
      serviceDirectory: fixture.directory,
      javaExecutable: fixture.javaExecutable,
      runtimeConfigurationPath,
      databasePath,
    });
    t.after(() => session.close());
    const started = await fixture.started();
    assert.equal(await readFile(fileURLToPath(started.config), "utf8"), wire);
    assert.equal(started.database, databasePath);
    await session.close();
    await assert.rejects(access(dirname(fileURLToPath(started.config))), {
      code: "ENOENT",
    });
    assert.equal(
      await readFile(databasePath, "utf8"),
      "previous committed state",
    );
    assert.equal(await readFile(runtimeConfigurationPath, "utf8"), wire);
  },
);

test(
  "explicit database path is absolute and passed as one argument",
  processTestOptions,
  async (t) => {
    await assert.rejects(
      startZooGlassSession({ databasePath: "relative.sqlite" }),
      /must be absolute/,
    );
    const fixture = await serviceFixture(t, "healthy");
    const databasePath = `${fixture.directory}/store with spaces.sqlite`;
    const session = await startZooGlassSession({
      serviceDirectory: fixture.directory,
      javaExecutable: fixture.javaExecutable,
      databasePath,
    });
    t.after(() => session.close());
    assert.equal((await fixture.started()).database, databasePath);
  },
);
