import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

test(
  "SIGINT during continuous demo startup releases the child and temporary configuration",
  { skip: process.platform === "win32", timeout: 15000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "driving-startup-"));
    const bin = join(root, "bin");
    const pidFile = join(root, "child.pid");
    await mkdir(bin);
    await writeFile(
      join(bin, "java"),
      '#!/bin/sh\necho $$ > "$CHILD_PID_FILE"\nexec sleep 60\n',
      { mode: 0o755 },
    );
    const cli = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "src/demos/vehicle/demo.ts",
        "vehicle-tracker",
        "--continuous",
      ],
      {
        env: {
          ...process.env,
          JAVA_HOME: root,
          TMPDIR: root,
          CHILD_PID_FILE: pidFile,
        },
        stdio: "ignore",
      },
    );
    const exited = once(cli, "exit", { signal: AbortSignal.timeout(12000) });
    let pid: number | undefined;
    try {
      for (let i = 0; i < 200 && !pid; i++) {
        pid =
          Number(await readFile(pidFile, "utf8").catch(() => "")) || undefined;
        if (!pid) await delay(25);
      }
      assert.ok(pid, "service process started");
      cli.kill("SIGINT");
      await exited;
      assert.throws(() => process.kill(pid!, 0), { code: "ESRCH" });
      assert.deepEqual(
        (await readdir(root)).filter((name) =>
          name.startsWith("zooglass-workbench-"),
        ),
        [],
      );
    } finally {
      cli.kill("SIGKILL");
      if (pid) killFixture(pid);
      await rm(root, { recursive: true, force: true });
    }
  },
);

function killFixture(pid: number) {
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}
