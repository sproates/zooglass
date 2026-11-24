import assert from "node:assert/strict";
import test from "node:test";
import { clientDiagnostic } from "../src/benchmark/diagnostic.js";
import { baseline } from "../src/benchmark/workload.js";
import { diagnosticPlan } from "../src/benchmark/sampling-diagnostic.js";

test("sampling experiment pairs all rates and alternates order without changing work", () => {
  const plan = diagnosticPlan();
  assert.equal(plan.length, 24);
  assert.equal(
    plan.reduce((n, t) => n + t.durationMs, 0),
    720000,
  );
  for (const rate of [10, 100, 300, 1000]) {
    const trials = plan.filter((t) => t.rate === rate);
    assert.deepEqual(
      trials.map((t) => t.sampled),
      [false, true, true, false, false, true],
    );
    assert.deepEqual(
      trials.map((t) => t.repeat),
      [1, 1, 2, 2, 3, 3],
    );
  }
});

test("captured diagnostic preserves skipped slots and complete submitted accounting", async () => {
  let now = 0;
  const result = await clientDiagnostic(baseline, {
    rate: 1000,
    durationMs: 10,
    capture: true,
    clock: {
      now: () => now,
      async sleep() {
        now += now === 0 ? 6 : 1;
      },
    },
  });
  assert.equal(result.submitted, 5);
  assert.equal(result.missed, 5);
  assert.equal(result.qualified, false);
  assert.deepEqual(
    result.timing!.submissions.map((s) => s.plannedMs),
    [0, 6, 7, 8, 9],
  );
  assert.equal(result.timing!.lateSubmissions, 0);
  assert.equal(result.accounting.phases.measurement.acknowledged, 5);
  assert.equal(result.accounting.pending, 0);
});

test("submission crossing its slot is recorded even when wake was timely", async () => {
  let reads = 0;
  const result = await clientDiagnostic(baseline, {
    rate: 1000,
    durationMs: 1,
    capture: true,
    clock: { now: () => (++reads <= 2 ? 0 : 2), async sleep() {} },
  });
  assert.equal(result.submitted, 1);
  assert.equal(result.missed, 0);
  assert.equal(result.timing!.lateSubmissions, 1);
});

test("diagnostic rejects invalid timing and cancellation", async () => {
  await assert.rejects(
    clientDiagnostic(baseline, { rate: 1001, durationMs: 10 }),
    /Invalid benchmark/,
  );
  const controller = new AbortController();
  controller.abort(new Error("cancelled diagnostic"));
  await assert.rejects(
    clientDiagnostic(baseline, {
      rate: 10,
      durationMs: 100,
      signal: controller.signal,
    }),
    /cancelled diagnostic/,
  );
});

test(
  "smoke experiment saves both arms and closes its owned prepared JVM",
  { timeout: 60000 },
  async () => {
    const { mkdtemp, readFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { runSamplingDiagnostic } =
      await import("../src/benchmark/sampling-diagnostic.js");
    const parent = await mkdtemp(join(tmpdir(), "sampling-test-"));
    const directory = join(parent, "new");
    try {
      await runSamplingDiagnostic(directory, "artifact-only wiring test", true);
      const read = async (name: string) =>
        JSON.parse(await readFile(join(directory, name), "utf8"));
      assert.equal((await read("completion.json")).complete, true);
      assert.equal((await read("manifest.json")).smoke, true);
      const off = await read("trial-01.json");
      const on = await read("trial-02.json");
      assert.equal(off.trial.sampled, false);
      assert.deepEqual(off.resources, []);
      assert.equal(on.trial.sampled, true);
      assert.ok(on.resources.length > 0);
      for (const trial of [off, on]) {
        assert.equal(trial.result.submitted + trial.result.missed, 100);
        assert.equal(
          trial.result.timing.submissions.length,
          trial.result.submitted,
        );
        assert.equal(trial.result.accounting.pending, 0);
      }
      const pid = on.resources[0].service.pid;
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
      await assert.rejects(
        runSamplingDiagnostic(directory, "must not overwrite", true),
        { code: "EEXIST" },
      );
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  test(
    `sampling CLI ${signal} closes its owned JVM`,
    { timeout: 60000 },
    async () => {
      const { spawn } = await import("node:child_process");
      const { mkdtemp, rm } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const { setTimeout: delay } = await import("node:timers/promises");
      const parent = await mkdtemp(join(tmpdir(), "sampling-interrupt-"));
      const child = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          "src/benchmark/sampling-cli.ts",
          join(parent, "new"),
          "--conditions",
          "interruption regression",
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let output = "";
      let pid: number | undefined;
      const capture = (chunk: Buffer) => {
        output += String(chunk);
        const match = /with PID (\d+)/.exec(output);
        if (match) pid = Number(match[1]);
      };
      child.stdout.on("data", capture);
      child.stderr.on("data", capture);
      const exited = new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", () => resolve());
      });
      const deadlineTimer = new AbortController();
      try {
        const deadline = Date.now() + 45000;
        while (!output.includes("Completed initialization in")) {
          assert.equal(child.exitCode, null, output);
          assert.ok(Date.now() < deadline, output);
          await delay(20);
        }
        assert.ok(pid && Number.isSafeInteger(pid) && pid > 0, output);
        child.kill(signal);
        await Promise.race([
          exited,
          delay(10000, undefined, { signal: deadlineTimer.signal }).then(() => {
            throw new Error(
              "Interrupted diagnostic did not exit within ten seconds",
            );
          }),
        ]);
        assert.equal(child.exitCode, 1, output);
        assert.throws(() => process.kill(pid!, 0), { code: "ESRCH" });
      } finally {
        deadlineTimer.abort();
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGKILL");
        if (pid) {
          try {
            process.kill(pid, "SIGTERM");
          } catch {
            /* Already closed by the command. */
          }
        }
        await Promise.race([exited, delay(2000)]);
        await rm(parent, { recursive: true, force: true });
      }
    },
  );
}
