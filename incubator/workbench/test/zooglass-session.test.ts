import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { startZooGlassSession } from "../src/zooglass-session.js";
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
      views,
      shutdownTimeoutMs: 50,
    });

    t.after(() => session.close());

    const { pid, config } = await fixture.started();

    assert.deepEqual(
      JSON.parse(await readFile(fileURLToPath(config), "utf8")),
      { views },
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

test("spawn errors reject promptly and cancellation prevents startup", async () => {
  await assert.rejects(
    startZooGlassSession({
      serviceDirectory: "/nonexistent/workbench-service",
    }),
    /aborted|ENOENT/,
  );
  await assert.rejects(
    startZooGlassSession({ signal: AbortSignal.abort(new Error("cancelled")) }),
    /cancelled/,
  );
});
