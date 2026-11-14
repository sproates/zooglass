import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { boundedFile, decode } from "../src/timeline/admission.js";
import type { DocumentRun } from "../src/timeline/campaign-checks.js";
import { executeDocument } from "../src/timeline/run-document.js";
import { workbenchIdentity } from "../src/timeline/manifest.js";
import {
  captureControlInput,
  comparableRuns,
  jarEntry,
  jarInventory,
  readJar,
} from "./generation-clock-check.js";

const sourceFile =
  "src/main/java/io/zooglass/strategy/update/LatestBySequence.java";
const classFile = "io/zooglass/strategy/update/LatestBySequence.class";
const before = `        JsonNode nextSequence = SequenceValues.read(incoming, sequenceField);
        if (nextSequence == null) {
            return FieldUpdate.unchanged();
        }

        JsonNode currentSequence = SequenceValues.read(current, sequenceField);
        if (currentSequence != null && SequenceValues.compare(nextSequence, currentSequence) <= 0) {
            return FieldUpdate.unchanged();
        }

`;
const recipe = new URL("prepare-fleet-strategy-mutation.py", import.meta.url);
const helper = new URL("prepare-generation-clock-mutation.py", import.meta.url);
const checkout = fileURLToPath(new URL("../..", import.meta.url));
const mode = { hostDelay: 70, jvmPauseMs: 90 };
const digest = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");
const git = (args: string[]) =>
  execFileSync("git", args, {
    cwd: checkout,
    timeout: 15_000,
    maxBuffer: 16 * 1024 * 1024,
  });
type Preparation = {
  format: string;
  revision: string;
  sourceArchiveSha256: string;
  recipeSha256: string;
  helperSha256: string;
  mutation: Record<string, string>;
  runtime: { entry: string; normal: string; mutant: string };
  artifacts: { normal: string; mutant: string };
  changedEntries: string[];
  changedRuntimeEntries: string[];
};

function changedEntries(
  normal: ReadonlyMap<string, string>,
  mutant: ReadonlyMap<string, string>,
  declared: string[],
  allowed: string,
  required: string,
) {
  assert.deepEqual(
    [...normal.keys()].sort(),
    [...mutant.keys()].sort(),
    "prepared artifact layouts differ",
  );
  const changed = [...normal.keys()]
    .filter((key) => normal.get(key) !== mutant.get(key))
    .sort();
  assert.deepEqual(
    changed,
    declared,
    "actual changed entries do not match preparation",
  );
  assert.deepEqual(
    changed.filter((key) => key !== allowed),
    [required],
    "unexpected artifact content changes",
  );
}

export function verifyFleetInventories(
  normal: ReadonlyMap<string, string>,
  mutant: ReadonlyMap<string, string>,
  normalRuntime: ReadonlyMap<string, string>,
  mutantRuntime: ReadonlyMap<string, string>,
  provenance: Pick<
    Preparation,
    "runtime" | "mutation" | "changedEntries" | "changedRuntimeEntries"
  >,
) {
  const entries = [...normal.keys()].filter((key) =>
    /^BOOT-INF\/lib\/zooglass-[\w.-]+-runtime\.jar$/.test(key),
  );
  assert.deepEqual(
    entries,
    [provenance.runtime.entry],
    "expected one embedded production runtime",
  );
  changedEntries(
    normal,
    mutant,
    provenance.changedEntries,
    "META-INF/maven/io.zooglass/zooglass-simulation/pom.properties",
    provenance.runtime.entry,
  );
  changedEntries(
    normalRuntime,
    mutantRuntime,
    provenance.changedRuntimeEntries,
    "META-INF/maven/io.zooglass/zooglass/pom.properties",
    classFile,
  );
  for (const [name, inventory] of [
    ["normal", normal],
    ["mutant", mutant],
  ] as const)
    assert.equal(
      inventory.get(provenance.runtime.entry),
      provenance.runtime[name],
      "embedded runtime identity mismatch",
    );
  assert.equal(
    normalRuntime.get(classFile),
    provenance.mutation.originalClassSha256,
  );
  assert.equal(
    mutantRuntime.get(classFile),
    provenance.mutation.mutatedClassSha256,
  );
}

async function readPreparation(directory: string) {
  const manifest = await boundedFile(join(directory, "preparation.json"));
  const provenance = JSON.parse(decode(manifest)) as Preparation;
  assert.equal(provenance.format, "timeline-fleet-strategy-preparation/v1");
  assert.match(provenance.revision, /^[0-9a-f]{40}$/);
  assert.equal(provenance.recipeSha256, digest(await readFile(recipe)));
  assert.equal(provenance.helperSha256, digest(await readFile(helper)));
  assert.equal(
    provenance.sourceArchiveSha256,
    digest(git(["archive", "--format=tar", provenance.revision, "zooglass"])),
  );
  const original = decode(
    await boundedFile(join(directory, "strategy-original.java")),
  );
  const mutated = decode(
    await boundedFile(join(directory, "strategy-mutant.java")),
  );
  assert.equal(
    original,
    git(["show", `${provenance.revision}:zooglass/${sourceFile}`]).toString(),
  );
  assert.equal(original.split(before).length, 2);
  assert.equal(mutated, original.replace(before, ""));
  assert.deepEqual(provenance.mutation, {
    file: sourceFile,
    before,
    after: "",
    originalSha256: digest(original),
    mutatedSha256: digest(mutated),
    class: classFile,
    originalClassSha256: provenance.mutation.originalClassSha256,
    mutatedClassSha256: provenance.mutation.mutatedClassSha256,
  });
  const jars = await Promise.all(
    ["normal", "mutant"].map((name) => readJar(join(directory, `${name}.jar`))),
  );
  for (const [index, name] of ["normal", "mutant"].entries())
    assert.equal(
      digest(jars[index]),
      provenance.artifacts[name as "normal" | "mutant"],
      `${name} artifact identity mismatch`,
    );
  const hosts = await Promise.all(jars.map(jarInventory));
  const runtimes = await Promise.all(
    jars.map(async (jar) =>
      jarInventory(await jarEntry(jar, provenance.runtime.entry)),
    ),
  );
  verifyFleetInventories(
    hosts[0],
    hosts[1],
    runtimes[0],
    runtimes[1],
    provenance,
  );
  return { provenance, manifest, original, mutated };
}

export function checkFleetStrategyControl(
  normal: DocumentRun,
  mutant: DocumentRun,
  paused: DocumentRun,
) {
  const { good, bad, mismatchIndex } = comparableRuns(
    normal,
    mutant,
    paused,
    "frames-240",
  );
  const oracle = (record: (typeof good)[number]) =>
    record.kind === "assertion" && record.data.assertionId === "frames-240";
  const passing = good.find(oracle);
  const failing = bad.find(oracle);
  assert.equal(passing?.data.passed, true);
  assert.equal(failing?.data.passed, false);
  assert.equal(failing.key[0], 240);
  assert.deepEqual(failing.data.expected, passing.data.expected);
  const atLate = (records: typeof good) =>
    records
      .filter((record) => record.kind === "state" && record.key[0] === 240)
      .map((record) => record.data.envelope);
  const normalStates = atLate(good);
  const mutantStates = atLate(bad);
  assert.deepEqual(
    normalStates.map((state) => state.viewId),
    ["received-journey"],
  );
  const wrong = mutantStates.find((state) => state.viewId === "fleet-state");
  assert.ok(wrong, "arrival mutation must publish a wrong latest position");
  assert.equal(wrong.entityId, "car-17");
  assert.equal(wrong.version, 9);
  assert.deepEqual(wrong.data.position, {
    publicationSequence: 41,
    payload: { sequence: 41, latitude: 36.141, longitude: -5.3534 },
  });
  const lastFleet = passing.data.actual
    .filter(
      (frame: { viewId?: string; entityId?: string }) =>
        frame.viewId === "fleet-state" && frame.entityId === "car-17",
    )
    .at(-1);
  assert.equal(lastFleet.version, 7);
  assert.deepEqual(lastFleet.data.position, {
    sequence: 42,
    latitude: 36.1412,
    longitude: -5.3532,
  });
  assert.deepEqual(
    mutantStates.filter((state) => state.viewId === "received-journey"),
    normalStates,
    "history remains correct while latest regresses",
  );
  assert.equal(
    failing.data.actual.length,
    passing.data.actual.length + 1,
    "extra late latest frame must reach the literal client oracle",
  );
  const generations = paused.diagnostics.generations ?? [];
  assert.ok(
    generations.some((generation) =>
      generation.jvm?.pauses.some(
        (pause) =>
          pause.virtualMs === 60 &&
          pause.site === "state-effect" &&
          pause.requestedMillis === mode.jvmPauseMs &&
          pause.elapsedNanos >= mode.jvmPauseMs * 1_000_000,
      ),
    ),
    "observe JVM pause during first state effect",
  );
  assert.ok(
    generations.some((generation) =>
      generation.node.some(
        (pause) =>
          pause.timeMs === 240 &&
          pause.operation === "ingress" &&
          pause.requestedMillis === mode.hostDelay &&
          pause.elapsedNanos >= mode.hostDelay * 1_000_000,
      ),
    ),
    "observe Node delay before late input",
  );
  return {
    failedAssertion: "frames-240",
    mismatchIndex,
    expectedSequence: 42,
    actualSequence: 41,
  };
}

async function captureSource() {
  const sourceRevision = git(["rev-parse", "HEAD"]).toString().trim();
  const status = git(["status", "--porcelain", "--untracked-files=no"]);
  assert.equal(
    git(["status", "--porcelain", "--", "zooglass"]).toString().trim(),
    "",
    "production/host sources must remain committed and clean",
  );
  const untracked = git([
    "ls-files",
    "--others",
    "--exclude-standard",
    "--",
    "zooglass",
    "workbench",
  ])
    .toString()
    .trim()
    .split("\n")
    .filter(Boolean);
  const untrackedFiles = await Promise.all(
    untracked.map(async (path) => ({
      path,
      sha256: digest(await readFile(join(checkout, path))),
    })),
  );
  return {
    sourceRevision,
    javaSourceTree: git(["rev-parse", `${sourceRevision}:zooglass`])
      .toString()
      .trim(),
    trackedChanges: status.length > 0,
    trackedStatusSha256: digest(status),
    trackedDiffSha256: digest(
      git([
        "diff",
        "--binary",
        "--no-ext-diff",
        "--no-textconv",
        sourceRevision,
        "--",
      ]),
    ),
    untrackedFiles,
    checkerSha256: digest(await readFile(new URL(import.meta.url))),
    sharedCheckerSha256: digest(
      await readFile(new URL("generation-clock-check.ts", import.meta.url)),
    ),
    recipeSha256: digest(await readFile(recipe)),
    helperSha256: digest(await readFile(helper)),
    workbenchSha256: await workbenchIdentity(),
    dependencyLockSha256: digest(
      await readFile(new URL("../package-lock.json", import.meta.url)),
    ),
  };
}

async function main() {
  const [prepared, output, ...extra] = process.argv.slice(2);
  assert.ok(
    prepared && output && !extra.length,
    "Usage: fleet-strategy-check PREPARED_DIRECTORY NEW_EVIDENCE_DIRECTORY",
  );
  const directory = resolve(output);
  await mkdir(directory);
  let error: string | undefined;
  let source;
  let inputs;
  let manifestSha256;
  let preparationRevision;
  let details;
  const rows = [];
  try {
    source = await captureSource();
    const preparation = resolve(prepared);
    const control = await readPreparation(preparation);
    assert.equal(
      git(["rev-parse", `${control.provenance.revision}:zooglass`])
        .toString()
        .trim(),
      source.javaSourceTree,
      "prepared production/host sources must match this committed head",
    );
    preparationRevision = control.provenance.revision;
    manifestSha256 = digest(control.manifest);
    const path = fileURLToPath(
      new URL("../scenarios/timeline-fleet/scenario.json", import.meta.url),
    );
    const captured = await captureControlInput(path);
    inputs = captured.identities;
    await Promise.all(
      Object.entries({
        "preparation.json": control.manifest,
        "strategy-original.java": control.original,
        "strategy-mutant.java": control.mutated,
        "scenario.json": captured.input.scenario.canonical,
        "configuration.json": captured.input.wire,
      }).map(([name, payload]) =>
        writeFile(join(directory, name), payload, { flag: "wx" }),
      ),
    );
    const runs: Record<string, DocumentRun> = {};
    for (const name of ["normal", "mutant", "paused-mutant"] as const) {
      const artifact = name === "normal" ? "normal" : "mutant";
      const options =
        name === "paused-mutant" ? mode : { hostDelay: 0, jvmPauseMs: 0 };
      const run = await executeDocument(captured.input, {
        jar: join(preparation, `${artifact}.jar`),
        ...options,
      });
      const bytes = JSON.stringify(run) + "\n";
      await writeFile(join(directory, `${name}.json`), bytes, { flag: "wx" });
      runs[name] = run;
      rows.push({
        file: `${name}.json`,
        sha256: digest(bytes),
        options,
        outcome: run.outcome,
        message: run.message,
        execution: run.execution,
      });
      assert.equal(
        run.execution.artifactSha256,
        control.provenance.artifacts[artifact],
      );
      assert.equal(run.execution.workbenchSha256, source.workbenchSha256);
      assert.equal(
        run.environment.dependencyLockSha256,
        source.dependencyLockSha256,
      );
    }
    details = checkFleetStrategyControl(
      runs.normal,
      runs.mutant,
      runs["paused-mutant"],
    );
    assert.deepEqual(
      await captureSource(),
      source,
      "control sources changed during execution",
    );
    assert.deepEqual((await captureControlInput(path)).identities, inputs);
    assert.equal(
      digest((await readPreparation(preparation)).manifest),
      manifestSha256,
    );
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }
  await writeFile(
    join(directory, "summary.json"),
    JSON.stringify(
      {
        format: "timeline-fleet-strategy-control/v1",
        verified: !error,
        command: [
          process.execPath,
          ...process.execArgv,
          ...process.argv.slice(1),
        ],
        ...source,
        inputs,
        preparationRevision,
        preparationManifestSha256: manifestSha256,
        runs: rows,
        ...details,
        ...(error ? { error } : {}),
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
  if (error) throw new Error(error);
  console.log("Verified wrong arrival strategy at frames-240");
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  await main();
