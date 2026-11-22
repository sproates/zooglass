import assert from "node:assert/strict";
import test from "node:test";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { lockScript } from "../src/benchmark/campaign/ownership.js";

const exec = promisify(execFile);

test(
  "a killed campaign worker leaves the prepared JVM holding its lock until service exit",
  {
    skip: !["linux", "darwin"].includes(process.platform),
    timeout: 90_000,
  },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "zooglass-lock-"));
    const tag = "-Dzooglass.campaign.test=" + randomUUID();
    const ready = join(directory, "ready.json");
    const child = spawn(
      "python3",
      [
        lockScript,
        directory,
        process.execPath,
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `
    import {writeFile} from "node:fs/promises";
    import {startZooGlassSession} from "./src/service/zooglass-session.ts";
    const service = await startZooGlassSession({
      inheritedLockFd:Number(process.env.ZOOGLASS_CAMPAIGN_LOCK_FD),javaOptions:[process.env.PROBE_TAG]
    });
    await writeFile(process.env.PROBE_READY,JSON.stringify(service.processId),"utf8");
  `,
      ],
      {
        env: {
          ...process.env,
          TMPDIR: directory,
          TMP: directory,
          TEMP: directory,
          PROBE_TAG: tag,
          PROBE_READY: ready,
        },
        stdio: "ignore",
      },
    );
    const closed = once(child, "close");
    let pid: number | undefined;
    const stopService = async () => {
      // Only terminate the test-owned JVM identified by its unique launch argument.
      if (pid === undefined) {
        // If startup failed after spawn but before readiness, recover its PID by token.
        const list = await exec("ps", ["-axo", "pid=,command="]);
        const row = list.stdout
          .split("\n")
          .find((line) => line.includes(tag) && line.includes("-jar"));
        if (row) pid = Number(row.trimStart().split(/\s+/, 1)[0]);
      }
      if (pid) {
        const args = await exec("ps", [
          "-p",
          String(pid),
          "-o",
          "command=",
        ]).catch(() => undefined);
        if (args?.stdout.includes(tag)) process.kill(pid, "SIGTERM");
      }
    };
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
      await closed;
      await stopService();
      await rm(directory, { recursive: true, force: true });
    });
    const deadline = Date.now() + 60_000;
    while (pid === undefined) {
      assert.equal(
        child.exitCode,
        null,
        "service worker terminated before readiness",
      );
      assert.ok(Date.now() < deadline, "service startup timed out");
      try {
        const raw = await readFile(ready, "utf8");
        if (raw) pid = JSON.parse(raw);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (pid === undefined) await delay(25);
    }
    const probe = () =>
      exec("python3", [lockScript, directory, process.execPath, "-e", ""]);
    await assert.rejects(probe(), /still in use/);
    child.kill("SIGKILL");
    await closed;
    await assert.rejects(probe(), /still in use/);
    await stopService();
    const shutdown = Date.now() + 15_000;
    for (;;) {
      try {
        await probe();
        break;
      } catch (error) {
        if (!String(error).includes("still in use") || Date.now() >= shutdown)
          throw error;
        await delay(50);
      }
    }
  },
);

test(
  "two invocations verify and skip the completed real-service slot across storage modes",
  {
    skip: !["linux", "darwin"].includes(process.platform),
    timeout: 90_000,
  },
  async (t) => {
    const directory = await mkdtemp(
      join(tmpdir(), "zooglass-campaign-resume-"),
    );
    t.after(() => rm(directory, { recursive: true, force: true }));
    const run = (mode: string) =>
      exec(
        "python3",
        [
          lockScript,
          directory,
          process.execPath,
          "--import",
          "tsx",
          "test/fixtures/benchmark-short-campaign.ts",
          directory,
          mode,
        ],
        { maxBuffer: 2 * 1024 * 1024, timeout: 40_000 },
      );
    await run("create");
    const first = join(directory, "attempts", "attempt-001", "completed.json");
    const original = await readFile(first);
    await run("resume");
    assert.deepEqual(await readFile(first), original);
    const { data } = JSON.parse(
      await readFile(join(directory, "journal.json"), "utf8"),
    );
    assert.deepEqual(
      data.state.attempts.map((a: { slotId: string; sessionId: number }) => [
        a.slotId,
        a.sessionId,
      ]),
      [
        ["memory", 1],
        ["sqlite", 2],
      ],
    );
  },
);
