import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { boundedFile, decode } from "../src/timeline/admission.js";
import type {
  CampaignMode,
  DocumentRun,
} from "../src/timeline/campaign-checks.js";
import { workbenchIdentity } from "../src/timeline/manifest.js";
import { checkLifecycleCampaignRun } from "./lifecycle-campaign-checks.js";
import { lifecycleCampaignInputs } from "./lifecycle-campaign-inputs.js";

const qualificationRepetitions = 20;
const concurrency = 3;
const cwd = fileURLToPath(new URL("../", import.meta.url));
const childScript = "scripts/document-campaign-child.ts";
const runnerFiles = [
  "scripts/lifecycle-repeat.ts",
  "scripts/lifecycle-campaign-inputs.ts",
  "scripts/lifecycle-campaign-checks.ts",
  childScript,
  "scenarios/simulation/memory-restart.json",
  "scenarios/simulation/memory-restart-runtime.json",
  "package.json",
  "package-lock.json",
];
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" });
const sha = (bytes: string | Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

function cleanCheckout() {
  // Other untracked work may coexist. Every input and execution module must come from this commit.
  return (
    !git("status", "--porcelain", "--untracked-files=no").trim() &&
    !git("ls-files", "--others", "--", "src/timeline", ...runnerFiles).trim() &&
    runnerFiles.every((file) => git("ls-files", "--", file).trim() === file)
  );
}

function campaignMode(iteration: number): CampaignMode {
  if (iteration === 0)
    return { hostDelay: 0, paced: false, idlePauseMs: 0, jvmPauseMs: 0 };
  return iteration % 2 === 1
    ? { hostDelay: 70, paced: true, idlePauseMs: 70, jvmPauseMs: 90 }
    : { hostDelay: 90, paced: false, idlePauseMs: 0, jvmPauseMs: 70 };
}

async function freshRun(args: string[]) {
  await new Promise<void>((resolveRun, reject) => {
    const child = spawn(process.execPath, args, {
      cwd,
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    let timedOut = false;
    let processError: Error | undefined;
    function killGroup() {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH")
          child.kill("SIGKILL");
      }
    }
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-16_000);
    });
    const deadline = setTimeout(() => {
      timedOut = true;
      killGroup();
      child.stderr.destroy();
    }, 30_000);
    child.once("error", (error) => {
      processError = error;
      killGroup();
    });
    child.once("close", (code, signal) => {
      clearTimeout(deadline);
      if (timedOut)
        reject(new Error("Campaign infrastructure watchdog expired"));
      else if (processError) reject(processError);
      else if (code === 0) resolveRun();
      else {
        killGroup();
        reject(
          new Error(
            `Child exit ${signal ?? code}${stderr ? `: ${stderr}` : ""}`,
          ),
        );
      }
    });
  });
}

const [
  folder,
  jarPath = "../zooglass/simulation-host/target/zooglass-simulation.jar",
  count = "20",
  ...extra
] = process.argv.slice(2);
if (
  !folder ||
  extra.length ||
  (count !== "2" && count !== String(qualificationRepetitions))
)
  throw new Error(
    "Usage: timeline:lifecycle-repeat NEW_DIRECTORY [PREPARED_JAR] [20|2(smoke)]",
  );
if (process.platform === "win32")
  throw new Error("Lifecycle campaign watchdog requires POSIX process groups");

const sourceRevision = git("rev-parse", "HEAD").trim();
const sourceClean = cleanCheckout();
const repetitions = Number(count);
if (repetitions === qualificationRepetitions && !sourceClean)
  throw new Error(
    "Qualification requires a clean committed checkout of the tools and fixtures",
  );

const directory = resolve(folder);
const jar = resolve(jarPath);
const artifactSha256 = sha(await readFile(jar));
const workbenchSha256 = await workbenchIdentity();
const hashTools = () =>
  Promise.all(
    runnerFiles.map(async (path) => ({
      path,
      sha256: sha(await readFile(join(cwd, path))),
    })),
  );
const toolFiles = await hashTools();
const startedAt = new Date().toISOString();
await mkdir(directory);
await mkdir(join(directory, "inputs"));
await mkdir(join(directory, "runs"));
const { configuration, groups } = await lifecycleCampaignInputs(
  join(directory, "inputs"),
);
const configurationPath = `inputs/${configuration}`;
const configurationBytes = await boundedFile(
  join(directory, configurationPath),
);
const configurationWire = decode(configurationBytes);
const configurationSha256 = sha(configurationBytes);

type Group = (typeof groups)[number];
type Job = { group: Group; iteration: number };
type Row = {
  group: string;
  iteration: number;
  path: string;
  argv: string[];
  mode: CampaignMode;
  runSha256?: string;
  traceSha256?: string;
  outcome?: string;
};
const baselines = new Map<string, DocumentRun>();
const rows: Row[] = [];
const failures: (Row & { error: string; evidenceError?: string })[] = [];
let environment: DocumentRun["environment"] | undefined;
let error: string | undefined;

async function run({ group, iteration }: Job) {
  const path = `runs/${group.id}-${iteration}.json`;
  const output = join(directory, path);
  const mode = campaignMode(iteration);
  const args = [
    "--import",
    "tsx",
    childScript,
    group.path,
    output,
    jar,
    JSON.stringify(mode),
  ];
  const row: Row = {
    group: group.id,
    iteration,
    path,
    argv: [process.execPath, ...args],
    mode,
  };
  let raw: string | undefined;
  try {
    await freshRun(args);
    raw = decode(await boundedFile(output));
    row.runSha256 = sha(raw);
    const result = checkLifecycleCampaignRun(
      raw,
      baselines.get(group.id),
      mode,
      group.expected,
    );
    row.outcome = result.outcome;
    row.traceSha256 = sha(result.trace);
    assert.equal(
      result.scenario + "\n",
      group.bytes,
      "retained scenario identity drift",
    );
    assert.equal(
      result.configuration,
      configurationWire,
      "retained configuration identity drift",
    );
    assert.deepEqual(
      result.execution,
      {
        profile: "receipt-age-restart-v1",
        artifactSha256,
        workbenchSha256,
        configurationSha256,
      },
      "campaign executable identity drift",
    );
    if (environment)
      assert.deepEqual(
        result.environment,
        environment,
        "campaign environment drift",
      );
    else environment = result.environment;
    if (iteration === 0) baselines.set(group.id, result);
    rows.push(row);
    if (rows.length % 10 === 0)
      console.log(
        `Verified ${rows.length}/${groups.length * repetitions} fresh Node/JVM lifecycle runs`,
      );
  } catch (cause) {
    const failure = { ...row, error: String(cause) } as Row & {
      error: string;
      evidenceError?: string;
    };
    try {
      raw ??= decode(await boundedFile(output));
      failure.runSha256 = sha(raw);
      const result: DocumentRun = JSON.parse(raw);
      failure.outcome = result.outcome;
      failure.traceSha256 = sha(result.trace);
    } catch (readError) {
      failure.evidenceError = String(readError);
    }
    failures.push(failure);
    throw new Error(`${group.id}/${iteration}: ${String(cause)}`, { cause });
  }
}

try {
  for (const group of groups) await run({ group, iteration: 0 });
  const jobs = groups.flatMap((group) =>
    Array.from({ length: repetitions - 1 }, (_, i) => ({
      group,
      iteration: i + 1,
    })),
  );
  let next = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (!error) {
        const job = jobs[next++];
        if (!job) return;
        try {
          await run(job);
        } catch (cause) {
          error ??= String(cause);
        }
      }
    }),
  );
  if (repetitions === qualificationRepetitions) {
    assert.ok(
      cleanCheckout() && sourceRevision === git("rev-parse", "HEAD").trim(),
      "qualification source changed during campaign",
    );
    assert.deepEqual(
      await hashTools(),
      toolFiles,
      "qualification tools or fixtures changed during campaign",
    );
    assert.equal(
      await workbenchIdentity(),
      workbenchSha256,
      "qualification timeline modules changed during campaign",
    );
    assert.equal(
      sha(await boundedFile(join(directory, configurationPath))),
      configurationSha256,
      "retained configuration changed during campaign",
    );
    for (const group of groups)
      assert.equal(
        sha(await boundedFile(group.path)),
        sha(group.bytes),
        `retained ${group.id} input changed during campaign`,
      );
    assert.equal(
      sha(await readFile(jar)),
      artifactSha256,
      "prepared JAR changed during campaign",
    );
  }
} catch (cause) {
  error ??= String(cause);
}

const expectedRuns = groups.length * repetitions;
const complete = !error && rows.length === expectedRuns;
const qualified = complete && repetitions === qualificationRepetitions;
const evidence = {
  format: "timeline-lifecycle-campaign/v1",
  command: [process.execPath, ...process.execArgv, ...process.argv.slice(1)],
  cwd,
  startedAt,
  finishedAt: new Date().toISOString(),
  sourceRevision,
  sourceClean,
  artifactSha256,
  workbenchSha256,
  toolFiles,
  environment,
  configuration: { path: configurationPath, sha256: configurationSha256 },
  repetitions,
  concurrency,
  expectedRuns,
  completedRuns: rows.length,
  complete,
  qualified,
  ...(error ? { error } : {}),
  groups: groups.map(({ id, filename, bytes, expected }) => ({
    id,
    input: `inputs/${filename}`,
    inputSha256: sha(bytes),
    expected,
    baselineTraceSha256: baselines.has(id)
      ? sha(baselines.get(id)!.trace)
      : null,
  })),
  failures,
  runs: rows.sort(
    (left, right) =>
      left.group.localeCompare(right.group) || left.iteration - right.iteration,
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
    qualified,
    completedRuns: rows.length,
    expectedRuns,
    ...(error ? { error } : {}),
  }),
);
if (!complete) process.exitCode = 1;
