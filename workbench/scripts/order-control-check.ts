import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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

const definitions = {
  priority: {
    file: "src/main/java/io/zooglass/strategy/contribution/SourcePriority.java",
    class: "io/zooglass/strategy/contribution/SourcePriority.class",
    before: "for (String source : sources) {",
    after: "for (String source : sources.reversed()) {",
    assertion: "committed-A-before-lost-ack-order-summary",
    time: 47,
  },
  clock: {
    file: "simulation-host/src/main/java/io/zooglass/runtime/ControlledReceiptClock.java",
    class: "BOOT-INF/classes/io/zooglass/runtime/ControlledReceiptClock.class",
    before: "return generation.wallMillis(turns.now());",
    after: "return Math.addExact(generation.epochMillis(), monotonicMillis());",
    assertion: "recovered-ready-order-summary",
    time: 15023,
  },
} as const;
type Control = keyof typeof definitions;
type Mutation = {
  file: string;
  class: string;
  before: string;
  after: string;
  originalSha256: string;
  mutatedSha256: string;
  changedEntries: string[];
  changedRuntimeEntries: string[];
  artifactSha256: string;
  runtimeSha256: string;
};
type Preparation = {
  format: string;
  revision: string;
  sourceArchiveSha256: string;
  recipeSha256: string;
  helperSha256: string;
  normalSha256: string;
  runtime: { entry: string; sha256: string };
  mutations: Record<Control, Mutation>;
};
const root = fileURLToPath(new URL("../..", import.meta.url));
const digest = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const git = (...args: string[]) =>
  execFileSync("git", args, {
    cwd: root,
    timeout: 15000,
    maxBuffer: 16 * 1024 * 1024,
  });
const mode = { hostDelay: 70, jvmPauseMs: 90 };

export function verifyOrderDelta(
  normal: ReadonlyMap<string, string>,
  mutant: ReadonlyMap<string, string>,
  declared: string[],
  required: string[],
  metadata: string,
) {
  assert.deepEqual(
    [...normal.keys()].sort(),
    [...mutant.keys()].sort(),
    "artifact layouts differ",
  );
  const changed = [...normal.keys()]
    .filter((key) => normal.get(key) !== mutant.get(key))
    .sort();
  assert.deepEqual(
    changed,
    declared,
    "declared artifact delta differs from actual bytes",
  );
  assert.deepEqual(
    changed.filter((key) => key !== metadata),
    required,
    "unexpected artifact class changes",
  );
}
async function preparation(directory: string) {
  const wire = await readFile(join(directory, "preparation.json"));
  const data = JSON.parse(wire.toString()) as Preparation;
  assert.equal(data.format, "timeline-order-controls-preparation/v1");
  assert.match(data.revision, /^[0-9a-f]{40}$/);
  assert.equal(
    data.sourceArchiveSha256,
    digest(git("archive", "--format=tar", data.revision, "zooglass")),
  );
  assert.equal(
    git("rev-parse", `${data.revision}:zooglass`).toString(),
    git("rev-parse", "HEAD:zooglass").toString(),
    "prepared Java source tree changed",
  );
  for (const [file, hash] of [
    ["prepare-order-controls.py", data.recipeSha256],
    ["prepare-generation-clock-mutation.py", data.helperSha256],
  ])
    assert.equal(digest(await readFile(new URL(file, import.meta.url))), hash);
  const normalBytes = await readJar(join(directory, "normal.jar"));
  assert.equal(digest(normalBytes), data.normalSha256);
  const normal = await jarInventory(normalBytes);
  const entries = [...normal.keys()].filter((key) =>
    /^BOOT-INF\/lib\/zooglass-[\w.-]+-runtime\.jar$/.test(key),
  );
  assert.deepEqual(entries, [data.runtime.entry]);
  assert.equal(normal.get(data.runtime.entry), data.runtime.sha256);
  const normalRuntime = await jarInventory(
    await jarEntry(normalBytes, data.runtime.entry),
  );
  for (const name of ["priority", "clock"] as const) {
    const definition = definitions[name],
      mutation = data.mutations[name];
    for (const key of ["file", "class", "before", "after"] as const)
      assert.equal(mutation[key], definition[key]);
    const original = await readFile(
      join(directory, `${name}-original.java`),
      "utf8",
    );
    const mutated = await readFile(
      join(directory, `${name}-mutant.java`),
      "utf8",
    );
    assert.equal(
      original,
      git("show", `${data.revision}:zooglass/${definition.file}`).toString(),
    );
    assert.equal(original.split(definition.before).length, 2);
    assert.equal(
      mutated,
      original.replace(definition.before, definition.after),
    );
    assert.equal(digest(original), mutation.originalSha256);
    assert.equal(digest(mutated), mutation.mutatedSha256);
    const bytes = await readJar(join(directory, `${name}.jar`));
    assert.equal(digest(bytes), mutation.artifactSha256);
    const host = await jarInventory(bytes);
    assert.equal(host.get(data.runtime.entry), mutation.runtimeSha256);
    const runtime = await jarInventory(
      await jarEntry(bytes, data.runtime.entry),
    );
    verifyOrderDelta(
      normal,
      host,
      mutation.changedEntries,
      [name === "clock" ? definition.class : data.runtime.entry],
      "META-INF/maven/io.zooglass/zooglass-simulation/pom.properties",
    );
    verifyOrderDelta(
      normalRuntime,
      runtime,
      mutation.changedRuntimeEntries,
      name === "priority" ? [definition.class] : [],
      "META-INF/maven/io.zooglass/zooglass/pom.properties",
    );
  }
  return { data, wire };
}
export function checkOrderControl(
  name: Control,
  normal: DocumentRun,
  mutant: DocumentRun,
  paused: DocumentRun,
) {
  const definition = definitions[name];
  const { good, bad, mismatchIndex } = comparableRuns(
    normal,
    mutant,
    paused,
    definition.assertion,
  );
  const oracle = (record: (typeof good)[number]) =>
    record.kind === "assertion" &&
    record.data.assertionId === definition.assertion;
  const passing = good.find(oracle),
    failing = bad.find(oracle);
  assert.equal(passing?.data.passed, true);
  assert.equal(failing?.data.passed, false);
  assert.equal(failing.key[0], definition.time);
  assert.deepEqual(failing.data.expected, passing.data.expected);
  const expected = passing.data.actual.snapshot,
    actual = failing.data.actual.snapshot;
  if (name === "priority") {
    assert.equal(expected.provenance.delivery.sourceId, "courier-primary");
    assert.equal(actual.provenance.delivery.sourceId, "courier-backup");
  } else {
    for (const field of ["inventory", "delivery"]) {
      assert.equal(expected.status.fields[field].freshness, "stale");
      assert.equal(actual.status.fields[field].freshness, "ageUnknown");
      assert.equal(actual.status.fields[field].receivedAtMillis, null);
      assert.equal(
        expected.status.fields[field].receivedAtMillis,
        1700000000000 + (field === "inventory" ? 20 : 21),
      );
    }
    assert.equal(failing.runtimeGeneration, 2);
  }
  const diagnostics = paused.diagnostics.generations ?? [];
  assert.ok(
    diagnostics.some((generation) =>
      generation.jvm?.pauses.some(
        (pause) =>
          pause.site === "state-effect" &&
          pause.requestedMillis === mode.jvmPauseMs &&
          pause.elapsedNanos >= mode.jvmPauseMs * 1e6,
      ),
    ),
    "measured JVM pause required",
  );
  assert.ok(
    diagnostics.some((generation) =>
      generation.node.some(
        (pause) =>
          pause.operation === "ingress" &&
          pause.requestedMillis === mode.hostDelay &&
          pause.elapsedNanos >= mode.hostDelay * 1e6,
      ),
    ),
    "measured Node pause required",
  );
  return {
    failedAssertion: definition.assertion,
    mismatchIndex,
    timeMs: definition.time,
  };
}
async function main() {
  const [prepared, output, flag, ...extra] = process.argv.slice(2);
  assert.ok(
    prepared &&
      output &&
      !extra.length &&
      (flag === undefined || flag === "--smoke"),
    "Usage: order-control-check PREPARED NEW_EVIDENCE [--smoke]",
  );
  const sourceRevision = git("rev-parse", "HEAD").toString().trim();
  const tracked = git(
    "status",
    "--porcelain",
    "--untracked-files=no",
  ).toString();
  const untracked = git(
    "ls-files",
    "--others",
    "--exclude-standard",
    "--",
    "workbench",
    "zooglass",
  ).toString();
  const clean = !tracked.trim() && !untracked.trim();
  assert.ok(
    clean || flag === "--smoke",
    "qualification requires clean committed tools and fixtures",
  );
  const directory = resolve(output),
    preparedDirectory = resolve(prepared);
  const beforeIdentity = await workbenchIdentity();
  const checked = await preparation(preparedDirectory);
  const captured = await captureControlInput(
    fileURLToPath(
      new URL(
        "../scenarios/timeline-order-recovery/after.json",
        import.meta.url,
      ),
    ),
  );
  await mkdir(directory);
  await writeFile(join(directory, "preparation.json"), checked.wire);
  await writeFile(
    join(directory, "scenario.json"),
    captured.input.scenario.canonical,
  );
  await writeFile(join(directory, "runtime.json"), captured.input.wire);
  const files = [
    "order-control-check.ts",
    "generation-clock-check.ts",
    "prepare-order-controls.py",
    "prepare-generation-clock-mutation.py",
  ];
  const hashes = async () =>
    Promise.all(
      files.map(async (file) => ({
        file,
        sha256: digest(await readFile(new URL(file, import.meta.url))),
      })),
    );
  const toolFiles = await hashes(),
    runs = new Map<string, DocumentRun>();
  const details: Record<string, unknown> = {};
  let error: string | undefined;
  try {
    for (const [id, artifact, timing] of [
      ["normal", "normal", {}],
      ["priority", "priority", {}],
      ["priority-paused", "priority", mode],
      ["clock", "clock", {}],
      ["clock-paused", "clock", mode],
    ] as const) {
      const run = await executeDocument(captured.input, {
        jar: join(preparedDirectory, `${artifact}.jar`),
        diagnosticDirectory: directory,
        ...timing,
      });
      await writeFile(
        join(directory, `${id}.json`),
        JSON.stringify(run) + "\n",
        { flag: "wx" },
      );
      runs.set(id, run);
      assert.equal(
        run.execution.artifactSha256,
        artifact === "normal"
          ? checked.data.normalSha256
          : checked.data.mutations[artifact].artifactSha256,
      );
      assert.equal(run.execution.workbenchSha256, beforeIdentity);
      assert.equal(
        run.execution.configurationSha256,
        captured.input.configurationHash,
      );
      assert.equal(run.execution.profile, captured.input.scenario.profile);
    }
    for (const name of ["priority", "clock"] as const)
      details[name] = checkOrderControl(
        name,
        runs.get("normal")!,
        runs.get(name)!,
        runs.get(`${name}-paused`)!,
      );
    assert.equal(
      await workbenchIdentity(),
      beforeIdentity,
      "executor changed during controls",
    );
    assert.deepEqual(
      await hashes(),
      toolFiles,
      "control tools changed during execution",
    );
    assert.equal(git("rev-parse", "HEAD").toString().trim(), sourceRevision);
  } catch (failure) {
    error = failure instanceof Error ? failure.message : String(failure);
    throw failure;
  } finally {
    await writeFile(
      join(directory, "summary.json"),
      JSON.stringify(
        {
          format: "timeline-order-controls/v1",
          status: error ? "failed" : "passed",
          error,
          qualification: clean && flag !== "--smoke",
          sourceRevision,
          preparationRevision: checked.data.revision,
          workbenchSha256: beforeIdentity,
          inputs: captured.identities,
          preparationSha256: digest(checked.wire),
          toolFiles,
          details,
          runs: [...runs.keys()],
        },
        null,
        2,
      ) + "\n",
    );
  }
}
if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
)
  await main();
