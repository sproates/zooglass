import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

test(
  "cancelling the profile CLI preserves the reason and closes the owned service",
  { timeout: 45_000 },
  async () => {
    const parent = await mkdtemp(join(tmpdir(), "sqlite-profile-interrupt-"));
    const bin = join(parent, "bin");
    const target = join(parent, "pair");
    const pidFile = join(parent, "service.pid");
    await mkdir(bin);
    await writeFile(
      join(bin, "java"),
      `#!/usr/bin/env node
if (process.argv.includes("-version")) {
  console.error('openjdk version "25.0"');
} else {
  require("node:fs").writeFileSync(process.env.PROFILE_TEST_PID, String(process.pid));
  setInterval(() => {}, 1000);
}
`,
      { mode: 0o755 },
    );
    await writeFile(
      join(bin, "jfr"),
      '#!/usr/bin/env node\nconsole.log("class MethodTiming");\n',
      { mode: 0o755 },
    );
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "src/benchmark/profile/cli.ts",
        target,
        "--conditions",
        "CLI cancellation test",
        "--smoke",
      ],
      {
        env: { ...process.env, JAVA_HOME: parent, PROFILE_TEST_PID: pidFile },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    let error = "";
    child.stderr.on("data", (chunk) => {
      error += String(chunk);
    });
    const exit = once(child, "exit");
    let pid: number | undefined;
    try {
      const deadline = Date.now() + 30_000;
      while (!pid) {
        assert.equal(child.exitCode, null, error);
        assert.ok(
          Date.now() < deadline,
          "The service process did not start: " + error,
        );
        try {
          pid = Number(await readFile(pidFile, "utf8"));
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
        }
        if (!pid) await delay(20);
      }
      child.kill("SIGTERM");
      const timeout = new AbortController();
      try {
        await Promise.race([
          exit,
          delay(8000, undefined, { signal: timeout.signal }).then(() => {
            throw new Error(
              "The profile process failed to exit after cancellation",
            );
          }),
        ]);
      } finally {
        timeout.abort();
      }
      assert.equal(child.exitCode, 1, error);
      assert.throws(() => process.kill(pid!, 0), { code: "ESRCH" });
      const record = JSON.parse(
        await readFile(join(target, "completion.json"), "utf8"),
      );
      assert.equal(record.complete, false);
      assert.equal(record.interruptedArm, "unprofiled");
      assert.deepEqual(record.armsStarted, ["unprofiled"]);
      assert.equal(record.armsRetained, 0);
      assert.match(record.error, /interrupted/);
      assert.ok(
        JSON.parse(
          await readFile(join(target, "unprofiled/failure.json"), "utf8"),
        ).error,
      );
    } finally {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGTERM");
      if (pid) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          /* already stopped */
        }
      }
      await rm(parent, { recursive: true, force: true });
    }
  },
);
