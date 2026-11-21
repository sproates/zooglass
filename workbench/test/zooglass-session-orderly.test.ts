import assert from "node:assert/strict";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { startZooGlassSession } from "../src/service/zooglass-session.js";
import { serviceFixture } from "./support/service-process.js";

// These actual process tests establish POSIX exit conventions, not Windows taskkill behavior.
const processOptions = { skip: process.platform === "win32", timeout: 10_000 };
const views = [{ id: "position", fields: {} }];

for (const mode of ["term-0", "term-143", "healthy"] as const) {
  test(
    `strict close accepts owned graceful termination: ${mode}`,
    processOptions,
    async (t) => {
      const fixture = await serviceFixture(t, mode);
      const session = await startZooGlassSession({
        serviceDirectory: fixture.directory,
        javaExecutable: fixture.javaExecutable,
        views,
      });
      t.after(() => session.close());
      const { pid, config } = await fixture.started();

      await Promise.all([
        session.close({ requireOrderly: true }),
        session.close(),
        session.close({ requireOrderly: true }),
      ]);
      await session.close({ requireOrderly: true });

      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
      await assert.rejects(access(fileURLToPath(config)), { code: "ENOENT" });
    },
  );
}

for (const strictFirst of [false, true]) {
  test(
    `strict close rejects forced cleanup with ${strictFirst ? "strict" : "ordinary"} first caller`,
    processOptions,
    async (t) => {
      const fixture = await serviceFixture(t, "stubborn");
      const databasePath = join(fixture.directory, "caller.sqlite");
      await writeFile(databasePath, "caller-owned committed state");
      const session = await startZooGlassSession({
        serviceDirectory: fixture.directory,
        javaExecutable: fixture.javaExecutable,
        views,
        databasePath,
        shutdownTimeoutMs: 50,
      });
      t.after(() => session.close());
      const { pid, config } = await fixture.started();

      const strict = () =>
        assert.rejects(
          session.close({ requireOrderly: true }),
          /Orderly shutdown.*forced termination/,
        );
      const first = strictFirst ? strict() : session.close();
      await Promise.all([first, strict(), session.close()]);

      // Strict rejection happens after cleanup, and later callers see the original outcome.
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
      await assert.rejects(access(fileURLToPath(config)), { code: "ENOENT" });
      assert.equal(
        await readFile(databasePath, "utf8"),
        "caller-owned committed state",
      );
      await strict();
      await session.close();
    },
  );
}

test(
  "strict close rejects an unsuccessful graceful exit after cleanup",
  processOptions,
  async (t) => {
    const fixture = await serviceFixture(t, "term-7");
    const session = await startZooGlassSession({
      serviceDirectory: fixture.directory,
      javaExecutable: fixture.javaExecutable,
      views,
    });
    t.after(() => session.close());
    const { pid, config } = await fixture.started();

    await assert.rejects(
      session.close({ requireOrderly: true }),
      /Orderly shutdown.*code 7/,
    );

    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    await assert.rejects(access(fileURLToPath(config)), { code: "ENOENT" });
    await session.close();
  },
);

test(
  "strict close rejects a prior exit even with an otherwise accepted signal",
  processOptions,
  async (t) => {
    const fixture = await serviceFixture(t, "healthy");
    const session = await startZooGlassSession({
      serviceDirectory: fixture.directory,
      javaExecutable: fixture.javaExecutable,
      views,
    });
    t.after(() => session.close());
    const { pid, config } = await fixture.started();
    const exited = new Promise<void>((resolve) => {
      session.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    process.kill(pid, "SIGTERM");
    await exited;

    await assert.rejects(
      session.close({ requireOrderly: true }),
      /Orderly shutdown.*already exited/,
    );

    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    await assert.rejects(access(fileURLToPath(config)), { code: "ENOENT" });
    await session.close();
  },
);
