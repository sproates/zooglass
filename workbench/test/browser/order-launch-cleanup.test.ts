import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Exercise the actual harness, including a producer paused at its first checkpoint.
for (const pattern of ["Order browser renders", "firefox: live Order"]) {
  test(`Order harness cleans up after unavailable browser: ${pattern}`, async () => {
    const cache = await mkdtemp(join(tmpdir(), "order-empty-browser-"));
    const env = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: cache };
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "--test",
        `--test-name-pattern=${pattern}`,
        "test/browser/order-browser.test.ts",
      ],
      {
        env,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    let expired = false;
    const timer = setTimeout(() => {
      expired = true;
      if (process.platform === "win32") child.kill("SIGTERM");
      else process.kill(-child.pid!, "SIGTERM");
    }, 30_000);
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", resolve);
      });
      assert.equal(
        expired,
        false,
        `Failed launch retained resources:\n${output}`,
      );
      assert.equal(code, 1, output);
      assert.match(output, /Executable doesn't exist/);
    } finally {
      clearTimeout(timer);
      await rm(cache, { recursive: true, force: true });
    }
  });
}
