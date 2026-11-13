import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { buffer } from "node:stream/consumers";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fromBufferPromise } from "yauzl";
import {
  boundedFile,
  decode,
  loadDocument,
} from "../src/timeline/admission.js";
import type { DocumentRun } from "../src/timeline/campaign-checks.js";
import { executeDocument } from "../src/timeline/run-document.js";
import { parseReplay } from "../src/timeline/replay-document.js";

const epoch = 1_700_000_000_000;
const assertion = "fresh-after-restart";
const mode = { hostDelay: 70, jvmPauseMs: 90 };
const clockFile =
  "simulation-host/src/main/java/io/zooglass/runtime/ControlledReceiptClock.java";
const clockClass =
  "BOOT-INF/classes/io/zooglass/runtime/ControlledReceiptClock.class";
const buildProperties =
  "META-INF/maven/io.zooglass/zooglass-simulation/pom.properties";
const before = "return generation.wallMillis(turns.now());";
const after =
  "return Math.addExact(generation.epochMillis(), monotonicMillis());";
const digest = (value: Buffer | string) =>
  createHash("sha256").update(value).digest("hex");

type Preparation = {
  format: string;
  revision: string;
  sourceArchiveSha256: string;
  recipeSha256: string;
  java: string;
  commands: string[][];
  mutation: Record<string, string>;
  runtime: { entry: string; sha256: string };
  artifacts: { normal: string; mutant: string };
  changedEntries: string[];
};

const checkout = fileURLToPath(new URL("../..", import.meta.url));
function git(args: string[]) {
  return execFileSync("git", args, {
    cwd: checkout,
    timeout: 15_000,
    maxBuffer: 16 * 1024 * 1024,
  });
}

async function jarInventory(jar: Buffer) {
  const archive = await fromBufferPromise(jar, { decodeStrings: false });
  const entries = new Map<string, string>();
  const names = new Set<string>();
  let totalBytes = 0;
  try {
    assert.ok(archive.entryCount <= 4096, "oversized prepared JAR directory");
    for await (const entry of archive.eachEntry()) {
      const name = entry.fileNameRaw.toString("latin1");
      assert.ok(!names.has(name), `duplicate prepared host entry: ${name}`);
      names.add(name);
      if (name.endsWith("/")) continue;
      totalBytes += entry.uncompressedSize;
      assert.ok(
        entry.uncompressedSize <= 32 * 1024 * 1024 &&
          totalBytes <= 80 * 1024 * 1024,
        `oversized prepared JAR entry: ${name}`,
      );
      const bytes = await buffer(await archive.openReadStreamPromise(entry));
      assert.equal(
        bytes.length,
        entry.uncompressedSize,
        `prepared JAR entry size: ${name}`,
      );
      entries.set(name, digest(bytes));
    }
    return entries;
  } finally {
    archive.close();
  }
}

export function verifyClockInventories(
  normal: ReadonlyMap<string, string>,
  mutant: ReadonlyMap<string, string>,
  provenance: Pick<Preparation, "mutation" | "runtime" | "changedEntries">,
) {
  assert.deepEqual(
    [...normal.keys()].sort(),
    [...mutant.keys()].sort(),
    "prepared host layouts differ",
  );
  const changed = [...normal.keys()]
    .filter((name) => normal.get(name) !== mutant.get(name))
    .sort();
  assert.deepEqual(
    changed,
    provenance.changedEntries,
    "actual changed host entries do not match preparation",
  );
  assert.deepEqual(
    changed.filter((name) => name !== buildProperties),
    [clockClass],
    "unexpected host content changes",
  );
  assert.equal(
    normal.get(clockClass),
    provenance.mutation.originalClassSha256,
    "original clock class identity mismatch",
  );
  assert.equal(
    mutant.get(clockClass),
    provenance.mutation.mutatedClassSha256,
    "mutated clock class identity mismatch",
  );
  const embedded = [...normal.keys()].filter((name) =>
    /^BOOT-INF\/lib\/zooglass-[\w.-]+-runtime\.jar$/.test(name),
  );
  assert.deepEqual(
    embedded,
    [provenance.runtime.entry],
    "prepared host must embed one production runtime",
  );
  assert.equal(
    normal.get(provenance.runtime.entry),
    provenance.runtime.sha256,
    "embedded runtime identity mismatch",
  );
}

async function readJar(path: string) {
  const file = await open(path, "r");
  try {
    const stat = await file.stat();
    assert.ok(
      stat.isFile() && stat.size <= 64 * 1024 * 1024,
      "prepared artifact size outside limits",
    );
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      assert.ok(bytesRead, "prepared artifact ended unexpectedly");
      offset += bytesRead;
    }
    assert.equal(
      (await file.stat()).size,
      stat.size,
      "prepared artifact size changed",
    );
    return bytes;
  } finally {
    await file.close();
  }
}

async function readPreparation(directory: string) {
  const provenance = JSON.parse(
    decode(await boundedFile(join(directory, "preparation.json"))),
  ) as Preparation;
  assert.equal(provenance.format, "timeline-generation-clock-preparation/v1");
  assert.match(provenance.revision, /^[0-9a-f]{40}$/);
  assert.equal(
    provenance.recipeSha256,
    digest(
      await readFile(
        new URL("prepare-generation-clock-mutation.py", import.meta.url),
      ),
    ),
  );
  assert.equal(
    provenance.sourceArchiveSha256,
    digest(git(["archive", "--format=tar", provenance.revision, "zooglass"])),
  );
  const [original, mutated] = await Promise.all(
    ["clock-original.java", "clock-mutant.java"].map(async (name) =>
      decode(await boundedFile(join(directory, name))),
    ),
  );
  assert.equal(
    original,
    git(["show", `${provenance.revision}:zooglass/${clockFile}`]).toString(),
    "original clock must match the named source revision",
  );
  assert.equal(
    original.split(before).length,
    2,
    "mutation must replace exactly one wall clock expression",
  );
  assert.equal(mutated, original.replace(before, after));
  const mutation = provenance.mutation;
  assert.deepEqual(mutation, {
    file: clockFile,
    before,
    after,
    originalSha256: digest(original),
    mutatedSha256: digest(mutated),
    class: clockClass,
    originalClassSha256: mutation.originalClassSha256,
    mutatedClassSha256: mutation.mutatedClassSha256,
  });
  for (const hash of [
    mutation.originalClassSha256,
    mutation.mutatedClassSha256,
    provenance.runtime.sha256,
  ])
    assert.match(hash, /^[0-9a-f]{64}$/);
  assert.notEqual(mutation.originalClassSha256, mutation.mutatedClassSha256);
  assert.match(
    provenance.runtime.entry,
    /^BOOT-INF\/lib\/zooglass-[\w.-]+-runtime\.jar$/,
  );
  assert.notEqual(provenance.artifacts.normal, provenance.artifacts.mutant);
  const inventory = async (name: "normal" | "mutant") => {
    const bytes = await readJar(join(directory, `${name}.jar`));
    assert.equal(
      digest(bytes),
      provenance.artifacts[name],
      `${name} artifact identity mismatch`,
    );
    return jarInventory(bytes);
  };
  verifyClockInventories(
    await inventory("normal"),
    await inventory("mutant"),
    provenance,
  );
  return { provenance, original, mutated };
}

export function checkClockControl(
  normal: DocumentRun,
  mutant: DocumentRun,
  paused: DocumentRun,
) {
  assert.equal(
    normal.outcome,
    "passed",
    normal.message ?? "normal run must pass",
  );
  for (const run of [mutant, paused]) {
    assert.equal(
      run.outcome,
      "assertion-failed",
      "mutant must fail semantically after executing the scenario",
    );
    assert.equal(run.message, `assertion-failed: ${assertion}`);
    assert.equal(run.scenario, normal.scenario);
    assert.equal(run.configuration, normal.configuration);
    assert.deepEqual(run.environment, normal.environment);
    assert.deepEqual(run.execution, {
      ...normal.execution,
      artifactSha256: mutant.execution.artifactSha256,
    });
  }
  assert.notEqual(
    normal.execution.artifactSha256,
    mutant.execution.artifactSha256,
  );
  assert.equal(
    mutant.trace,
    paused.trace,
    "host pauses must leave the mutant's wrong semantic trace identical",
  );

  const normalLines = parseReplay(JSON.stringify(normal)).lines;
  const mutantLines = parseReplay(JSON.stringify(mutant)).lines;
  const good = normalLines.map((line) => JSON.parse(line));
  const bad = mutantLines.map((line) => JSON.parse(line));
  const starts = (events: typeof good) =>
    events.filter((record) => record.kind === "runtime-initialized");
  assert.deepEqual(
    starts(bad),
    starts(good),
    "mutation must preserve protocol clock evidence",
  );
  assert.deepEqual(
    starts(bad).map((record) => [record.runtimeGeneration, record.data]),
    [
      [1, { startTimeMs: 0, monotonicMs: 0, wallMillis: epoch, snapshots: [] }],
      [
        2,
        {
          startTimeMs: 50,
          monotonicMs: 0,
          wallMillis: epoch + 50,
          snapshots: [],
        },
      ],
    ],
  );

  const normalAssertion = good.find(
    (record) => record.data?.assertionId === assertion,
  );
  const badAssertionIndex = bad.findIndex(
    (record) => record.data?.assertionId === assertion,
  );
  const badAssertion = bad[badAssertionIndex];
  assert.equal(normalAssertion?.data.passed, true);
  assert.equal(badAssertion?.data.passed, false);
  assert.deepEqual(badAssertion.data.expected, normalAssertion.data.expected);
  const expected = structuredClone(badAssertion.data.expected);
  const frameIndex = expected.findIndex(
    (frame: {
      status?: { fields: { reading: { receivedAtMillis: number } } };
    }) => frame.status?.fields.reading.receivedAtMillis === epoch + 50,
  );
  assert.notEqual(
    frameIndex,
    -1,
    "scenario must expect a receipt timestamp at E+50",
  );
  expected[frameIndex].status.fields.reading.receivedAtMillis = epoch;
  assert.deepEqual(
    badAssertion.data.actual,
    expected,
    "the wrong receipt wall timestamp is the only frame change",
  );

  const mismatchIndex = normalLines.findIndex(
    (line, index) => index > 0 && line !== mutantLines[index],
  );
  assert.equal(good[mismatchIndex]?.kind, "state");
  assert.equal(good[mismatchIndex]?.runtimeGeneration, 2);
  assert.equal(good[mismatchIndex]?.key[0], 50);
  assert.equal(
    good[mismatchIndex]?.data.envelope.status.fields.reading.receivedAtMillis,
    epoch + 50,
  );
  assert.equal(
    bad[mismatchIndex]?.data.envelope.status.fields.reading.receivedAtMillis,
    epoch,
  );

  const generation = paused.diagnostics.generations?.find(
    (entry) => entry.runtimeGeneration === 2,
  );
  assert.ok(generation, "retain generation 2 pause diagnostics");
  assert.ok(
    generation.jvm?.pauses.some(
      (pause) =>
        pause.site === "state-effect" &&
        pause.virtualMs === 50 &&
        pause.requestedMillis === mode.jvmPauseMs &&
        pause.elapsedNanos >= mode.jvmPauseMs * 1_000_000,
    ),
    "observe the JVM pause inside generation 2 state processing",
  );
  assert.ok(
    generation.node.some(
      (pause) =>
        pause.operation === "ingress" &&
        pause.timeMs === 50 &&
        pause.requestedMillis === mode.hostDelay &&
        pause.elapsedNanos >= 30_000_000,
    ),
    "observe the Node delay before generation 2 ingress for at least the freshness threshold",
  );

  return {
    mismatchIndex,
    failedAssertionIndex: badAssertionIndex,
    expectedWallMillis: epoch + 50,
    actualWallMillis: epoch,
  };
}

async function main() {
  const [prepared, output, ...extra] = process.argv.slice(2);
  if (!prepared || !output || extra.length)
    throw new Error(
      "Usage: generation-clock-check PREPARED_DIRECTORY NEW_EVIDENCE_DIRECTORY",
    );
  const directory = resolve(output);
  await mkdir(directory);
  const results: Record<string, DocumentRun> = {};
  const rows = [];
  let details;
  let error: string | undefined;

  try {
    const preparation = resolve(prepared);
    const { provenance, original, mutated } =
      await readPreparation(preparation);
    const inputPath = fileURLToPath(
      new URL("../scenarios/simulation/memory-restart.json", import.meta.url),
    );
    const input = await loadDocument(inputPath);
    await Promise.all(
      Object.entries({
        "preparation.json": JSON.stringify(provenance, null, 2) + "\n",
        "clock-original.java": original,
        "clock-mutant.java": mutated,
        "scenario.json": input.scenario.canonical,
        "configuration.json": input.wire,
      }).map(([file, payload]) =>
        writeFile(join(directory, file), payload, { flag: "wx" }),
      ),
    );

    for (const name of ["normal", "mutant", "paused-mutant"] as const) {
      const artifact = name === "normal" ? "normal" : "mutant";
      const options =
        name === "paused-mutant" ? mode : { hostDelay: 0, jvmPauseMs: 0 };
      const run = await executeDocument(input, {
        jar: join(preparation, `${artifact}.jar`),
        ...options,
      });
      const file = `${name}.json`;
      const bytes = JSON.stringify(run) + "\n";
      await writeFile(join(directory, file), bytes, { flag: "wx" });
      results[name] = run;
      rows.push({
        file,
        sha256: digest(bytes),
        options,
        outcome: run.outcome,
        message: run.message,
        execution: run.execution,
      });
      assert.equal(
        run.execution.artifactSha256,
        provenance.artifacts[artifact],
      );
    }
    details = checkClockControl(
      results.normal,
      results.mutant,
      results["paused-mutant"],
    );
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }
  await writeFile(
    join(directory, "summary.json"),
    JSON.stringify(
      {
        format: "timeline-generation-clock-control/v1",
        verified: !error,
        command: [
          process.execPath,
          "--import",
          "tsx",
          ...process.argv.slice(1),
        ],
        sourceRevision: git(["rev-parse", "HEAD"]).toString().trim(),
        trackedChanges:
          git(["status", "--porcelain", "--untracked-files=no"]).length > 0,
        checkerSha256: digest(await readFile(new URL(import.meta.url))),
        runs: rows,
        ...(details ?? {}),
        ...(error ? { error } : {}),
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
  if (error) throw new Error(error);
  console.log(`Verified wrong-generation wall clock control at ${assertion}`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  await main();
