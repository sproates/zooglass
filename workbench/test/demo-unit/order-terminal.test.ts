import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

test(
  "interactive terminal runs Step, Help and Quit without building the service",
  { timeout: 20000 },
  async () => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "src/cli/demo.ts", "order-tracker", "--interactive"],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let output = "";
    child.stdout.on("data", (data) => {
      output += data;
    });
    child.stderr.on("data", (data) => {
      output += data;
    });
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    async function wait(pattern: RegExp) {
      const end = Date.now() + 12000;
      while (!pattern.test(output)) {
        assert.ok(Date.now() < end && child.exitCode === null, output);
        await delay(20);
      }
    }
    try {
      await wait(/Order walkthrough\. Open http/);
      child.stdin.write("step\n");
      await wait(/Step finished/);
      child.stdin.write("help\nquit\n");
      assert.equal(await exited, 0, output);
      assert.match(output, /Reset starts a fresh store/);
    } finally {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await exited;
      }
    }
  },
);
