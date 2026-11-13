import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { runDocument } from "../src/timeline/run-document.js";
import { checkCampaignRun } from "../src/timeline/campaign-checks.js";

const [normalJar, mutantJar, folder] = process.argv.slice(2);
if (!normalJar || !mutantJar || !folder)
  throw new Error(
    "Usage: clock-leak-check NORMAL_JAR PREPARED_MUTANT_JAR NEW_DIRECTORY",
  );
const directory = resolve(folder);
await mkdir(directory);
const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const jars = { normal: resolve(normalJar), mutant: resolve(mutantJar) };
assert.notEqual(
  hash(await readFile(jars.normal)),
  hash(await readFile(jars.mutant)),
);
const input = resolve("scenarios/simulation/warehouse-retry.json");
const expected = {
  draws: [],
  pauseTimes: { "writer-handoff": 0, "state-effect": 10, "alarm-dispatch": 60 },
};
const rows: Record<string, unknown>[] = [];
let error: string | undefined;
try {
  for (let repetition = 0; repetition < 3; repetition++) {
    for (const artifact of ["normal", "mutant"] as const) {
      let baseline: Awaited<ReturnType<typeof runDocument>> | undefined;
      for (const mode of ["baseline", "jvm", "node"] as const) {
        const options = {
          hostDelay: mode === "node" ? 70 : 0,
          jvmPauseMs: mode === "jvm" ? 90 : 0,
          paced: false,
          idlePauseMs: 0,
        };
        const run = await runDocument(input, {
          jar: jars[artifact],
          ...options,
        });
        const path = `${artifact}-${mode}-${repetition}.json`;
        const bytes = JSON.stringify(run, null, 2) + "\n";
        await writeFile(join(directory, path), bytes, { flag: "wx" });
        rows.push({
          artifact,
          mode,
          repetition,
          path,
          sha256: hash(bytes),
          outcome: run.outcome,
          message: run.message,
          execution: run.execution,
        });
        if (mode === "baseline") {
          assert.equal(run.outcome, "passed", "unpaused artifact must pass");
          baseline = run;
        } else if (artifact === "normal") {
          checkCampaignRun(run, baseline, options, expected);
        } else {
          assert.equal(
            run.outcome,
            "assertion-failed",
            "must fail semantically, not at admission",
          );
          assert.equal(run.message, "assertion-failed: fresh");
          assert.equal(
            run.execution.artifactSha256,
            baseline!.execution.artifactSha256,
          );
          assert.notEqual(run.trace, baseline!.trace);
          assert.throws(
            () => checkCampaignRun(run, baseline, options, expected),
            /assertion-failed: fresh/,
          );
          const records = run.trace
            .trimEnd()
            .split("\n")
            .map((line) => JSON.parse(line));
          assert.ok(
            records.some(
              (record) =>
                record.kind === "state" &&
                record.key[0] === 20 &&
                record.data.envelope.status.fields.reading.freshness ===
                  "stale",
            ),
            "real-clock leak must expire at retry time20, before virtual deadline60",
          );
        }
        if (mode === "node") {
          assert.ok(run.diagnostics.node.length > 1);
          for (const pause of run.diagnostics.node) {
            assert.equal(pause.requestedMillis, 70);
            assert.ok(
              pause.elapsedNanos >= 50_000_000,
              "actual pause must exceed freshness threshold",
            );
          }
          assert.ok(
            run.diagnostics.node.some(
              (p, i, all) =>
                i > 0 && p.timeMs === all[i - 1].timeMs && p.timeMs === 10,
            ),
            "must pause between runtime commands within publication timestamp",
          );
        }
        if (mode === "jvm") {
          assert.ok(
            run.diagnostics.jvm!.pauses.some(
              (p) =>
                p.site === "state-effect" &&
                p.virtualMs === 10 &&
                p.requestedMillis === 90 &&
                p.elapsedNanos >= 90_000_000,
            ),
          );
        }
        console.log(
          `Verified ${artifact}/${mode}/${repetition}: ${run.outcome}`,
        );
      }
    }
  }
} catch (cause) {
  error = String(cause);
}
await writeFile(
  join(directory, "summary.json"),
  JSON.stringify(
    {
      format: "timeline-clock-leak-check/v1",
      qualified: !error && rows.length === 18,
      expectedRuns: 18,
      runs: rows,
      ...(error ? { error } : {}),
    },
    null,
    2,
  ) + "\n",
  { flag: "wx" },
);
if (error) throw new Error(error);
