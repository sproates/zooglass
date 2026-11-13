import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { campaignInputs } from "./document-campaign-inputs.js";
import {
  checkCampaignRun,
  type DocumentRun,
  type CampaignMode,
} from "../src/timeline/campaign-checks.js";
const [
  folder,
  jarPath = "../zooglass/simulation-host/target/zooglass-simulation.jar",
  repeatText = "100",
] = process.argv.slice(2);
if (!folder || !/^(2|100)$/.test(repeatText))
  throw new Error(
    "Usage: timeline:document-repeat NEW_DIRECTORY [PREPARED_JAR] [100|2(smoke)]",
  );
const repetitions = Number(repeatText),
  directory = resolve(folder),
  jar = resolve(jarPath);
const sourceRevision = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
const sourceDirty =
  execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
    encoding: "utf8",
  }).trim().length > 0;
if (repetitions === 100 && sourceDirty)
  throw new Error("Qualification requires a clean committed checkout");
await mkdir(directory); // Never mix or overwrite campaigns.
await mkdir(join(directory, "inputs"));
await mkdir(join(directory, "runs"));
const groups = await campaignInputs(join(directory, "inputs"));
const hash = (text: string | Buffer) =>
  createHash("sha256").update(text).digest("hex");
const runnerHash = hash(
  (
    await Promise.all(
      [
        "document-repeat.ts",
        "document-campaign-child.ts",
        "document-campaign-inputs.ts",
      ].map((file) => readFile(new URL(file, import.meta.url))),
    )
  )
    .map((b) => `${b.length}:${b.toString()}`)
    .join(""),
);
const baseline = new Map<string, DocumentRun>();
const rows: Record<string, unknown>[] = [];
const failures: Record<string, unknown>[] = [];
let error: string | undefined;
const startedAt = new Date().toISOString();
async function child(input: string, output: string, mode: CampaignMode) {
  await new Promise<void>((done, fail) => {
    const processChild = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/document-campaign-child.ts",
        input,
        output,
        jar,
        JSON.stringify(mode),
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    processChild.stderr.on("data", (b) => {
      stderr = (stderr + String(b)).slice(-16000);
    });
    const timer = setTimeout(() => {
      processChild.kill("SIGKILL");
      fail(new Error("Campaign infrastructure watchdog expired"));
    }, 30000);
    processChild.once("error", (e) => {
      clearTimeout(timer);
      fail(e);
    });
    processChild.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) done();
      else fail(new Error(`Child exit ${code}: ${stderr}`));
    });
  });
}
async function run(group: (typeof groups)[number], iteration: number) {
  const mode: CampaignMode =
    iteration === 0
      ? { hostDelay: 0, paced: false, idlePauseMs: 0, jvmPauseMs: 0 }
      : {
          hostDelay: iteration % 3,
          paced: iteration % 2 === 1,
          idlePauseMs: iteration % 2 ? 70 : 0,
          jvmPauseMs: iteration % 3 === 1 ? 70 : 90,
        };
  const relative = `runs/${group.id}-${iteration}.json`,
    output = join(directory, relative);
  try {
    await child(group.path, output, mode);
    const bytes = await readFile(output);
    const actual = JSON.parse(bytes.toString()) as DocumentRun;
    checkCampaignRun(actual, baseline.get(group.id), mode, group.expected);
    const first = baseline.values().next().value as DocumentRun | undefined;
    if (first) {
      assert.deepEqual(
        actual.execution.artifactSha256,
        first.execution.artifactSha256,
        "campaign artifact drift",
      );
      assert.equal(
        actual.execution.workbenchSha256,
        first.execution.workbenchSha256,
        "campaign module drift",
      );
      assert.deepEqual(
        actual.environment,
        first.environment,
        "campaign environment drift",
      );
    }
    if (iteration === 0) baseline.set(group.id, actual);
    rows.push({
      group: group.id,
      iteration,
      path: relative,
      mode,
      runSha256: hash(bytes),
      traceSha256: hash(actual.trace),
      outcome: actual.outcome,
      pauses: actual.diagnostics.jvm!.pauses,
    });
    if (rows.length % 30 === 0)
      console.log(
        `Verified ${rows.length}/${groups.length * repetitions} fresh Node/JVM runs`,
      );
  } catch (cause) {
    const failure: Record<string, unknown> = {
      group: group.id,
      iteration,
      path: relative,
      mode,
      error: String(cause),
    };
    try {
      const bytes = await readFile(output);
      failure.runSha256 = hash(bytes);
      const result = JSON.parse(bytes.toString()) as DocumentRun;
      failure.outcome = result.outcome;
    } catch (readError) {
      failure.evidenceError = String(readError);
    }
    failures.push(failure);
    throw new Error(`${group.id}/${iteration}: ${String(cause)}`, { cause });
  }
}
try {
  for (const group of groups) await run(group, 0);
  const jobs = groups.flatMap((group) =>
    Array.from({ length: repetitions - 1 }, (_, i) => ({
      group,
      iteration: i + 1,
    })),
  );
  let next = 0;
  await Promise.all(
    Array.from({ length: 3 }, async () => {
      while (!error) {
        const job = jobs[next++];
        if (!job) return;
        try {
          await run(job.group, job.iteration);
        } catch (e) {
          error = String(e);
        }
      }
    }),
  );
} catch (e) {
  error = String(e);
}
const complete = !error && rows.length === groups.length * repetitions;
const evidence = {
  format: "timeline-document-campaign/v1",
  startedAt,
  finishedAt: new Date().toISOString(),
  runnerHash,
  sourceRevision,
  sourceDirty,
  repetitions,
  concurrency: 3,
  expectedRuns: groups.length * repetitions,
  completedRuns: rows.length,
  complete,
  qualified: complete && repetitions === 100,
  ...(error ? { error } : {}),
  groups: await Promise.all(
    groups.map(async (g) => ({
      id: g.id,
      input: `inputs/${g.id}.json`,
      inputSha256: hash(await readFile(g.path)),
      expected: g.expected,
      expectedOutcome: "passed",
      baseline: baseline.has(g.id)
        ? {
            execution: baseline.get(g.id)!.execution,
            environment: baseline.get(g.id)!.environment,
            traceSha256: hash(baseline.get(g.id)!.trace),
          }
        : null,
    })),
  ),
  failures,
  runs: rows.sort(
    (a, b) =>
      String(a.group).localeCompare(String(b.group)) ||
      Number(a.iteration) - Number(b.iteration),
  ),
};
await writeFile(
  join(directory, "summary.json"),
  JSON.stringify(evidence, null, 2) + "\n",
  { flag: "wx" },
);
console.log(
  JSON.stringify({
    complete,
    qualified: evidence.qualified,
    completedRuns: rows.length,
    expectedRuns: evidence.expectedRuns,
    ...(error ? { error } : {}),
  }),
);
if (!complete) process.exitCode = 1;
