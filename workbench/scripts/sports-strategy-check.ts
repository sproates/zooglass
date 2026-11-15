import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { executeDocument } from "../src/timeline/run-document.js";
import type { DocumentRun } from "../src/timeline/campaign-checks.js";
import { workbenchIdentity } from "../src/timeline/manifest.js";
import {
  captureControlInput,
  comparableRuns,
  jarEntry,
  jarInventory,
  readJar,
} from "./control-evidence.js";

const checkout = fileURLToPath(new URL("../..", import.meta.url));
const sourceFile =
  "src/main/java/io/zooglass/strategy/fact/FactRevisionSelection.java";
const classFile = "io/zooglass/strategy/fact/FactRevisionSelection.class";
const before = "return new LatestFactRevision();";
const after = "return new FirstFact();";
const recipe = new URL("prepare-sports-strategy-mutation.py", import.meta.url);
const helper = new URL("prepare-generation-clock-mutation.py", import.meta.url);
const mode = { hostDelay: 70, jvmPauseMs: 90 };
const sha = (value: Buffer | string) =>
  createHash("sha256").update(value).digest("hex");
const git = (...args: string[]) =>
  execFileSync("git", args, {
    cwd: checkout,
    timeout: 15000,
    maxBuffer: 16 * 1024 * 1024,
  });
type Preparation = {
  format: string;
  revision: string;
  sourceArchiveSha256: string;
  recipeSha256: string;
  helperSha256: string;
  mutation: {
    file: string;
    class: string;
    before: string;
    after: string;
    originalSha256: string;
    mutatedSha256: string;
    originalClassSha256: string;
    mutatedClassSha256: string;
  };
  runtime: { entry: string; normal: string; mutant: string };
  artifacts: { normal: string; mutant: string };
  changedEntries: string[];
  changedRuntimeEntries: string[];
};

export function verifySportsDelta(
  normal: ReadonlyMap<string, string>,
  mutant: ReadonlyMap<string, string>,
  declared: string[],
  required: string,
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
    "actual artifact delta differs from manifest",
  );
  assert.deepEqual(
    changed.filter((key) => key !== metadata),
    [required],
    "unexpected class or resource mutation",
  );
}

async function preparation(directory: string) {
  const bytes = await readFile(join(directory, "preparation.json"));
  const manifest = JSON.parse(bytes.toString()) as Preparation;
  assert.equal(manifest.format, "timeline-sports-strategy-preparation/v1");
  assert.match(manifest.revision, /^[a-f0-9]{40}$/);
  assert.equal(
    manifest.sourceArchiveSha256,
    sha(git("archive", "--format=tar", manifest.revision, "zooglass")),
  );
  assert.equal(manifest.recipeSha256, sha(await readFile(recipe)));
  assert.equal(manifest.helperSha256, sha(await readFile(helper)));
  const original = await readFile(
      join(directory, "strategy-original.java"),
      "utf8",
    ),
    mutated = await readFile(join(directory, "strategy-mutant.java"), "utf8");
  assert.equal(
    original,
    git("show", `${manifest.revision}:zooglass/${sourceFile}`).toString(),
  );
  assert.equal(original.split(before).length, 2);
  assert.equal(mutated, original.replace(before, after));
  assert.deepEqual(manifest.mutation, {
    file: sourceFile,
    class: classFile,
    before,
    after,
    originalSha256: sha(original),
    mutatedSha256: sha(mutated),
    originalClassSha256: manifest.mutation.originalClassSha256,
    mutatedClassSha256: manifest.mutation.mutatedClassSha256,
  });
  const artifacts = await Promise.all(
    ["normal", "mutant"].map((name) => readJar(join(directory, `${name}.jar`))),
  );
  const hosts = await Promise.all(artifacts.map(jarInventory));
  assert.deepEqual(
    [...hosts[0].keys()].filter((key) =>
      /^BOOT-INF\/lib\/zooglass-[\w.-]+-runtime\.jar$/.test(key),
    ),
    [manifest.runtime.entry],
  );
  const runtimes = await Promise.all(
    artifacts.map(async (jar) =>
      jarInventory(await jarEntry(jar, manifest.runtime.entry)),
    ),
  );
  verifySportsDelta(
    hosts[0],
    hosts[1],
    manifest.changedEntries,
    manifest.runtime.entry,
    "META-INF/maven/io.zooglass/zooglass-simulation/pom.properties",
  );
  verifySportsDelta(
    runtimes[0],
    runtimes[1],
    manifest.changedRuntimeEntries,
    classFile,
    "META-INF/maven/io.zooglass/zooglass/pom.properties",
  );
  for (const [index, name] of (["normal", "mutant"] as const).entries()) {
    assert.equal(sha(artifacts[index]), manifest.artifacts[name]);
    assert.equal(
      hosts[index].get(manifest.runtime.entry),
      manifest.runtime[name],
    );
    assert.equal(
      runtimes[index].get(classFile),
      manifest.mutation[
        index === 0 ? "originalClassSha256" : "mutatedClassSha256"
      ],
    );
  }
  return { manifest, bytes, original, mutated };
}

/** A real policy error must fail its unchanged literal assertion, never startup or evidence parsing. */
export function checkSportsStrategyControl(
  normal: DocumentRun,
  mutant: DocumentRun,
  paused: DocumentRun,
) {
  const assertion = "corrected-scorer-cycle-1-match-1-source-receipt";
  const { good, bad, mismatchIndex } = comparableRuns(
    normal,
    mutant,
    paused,
    assertion,
  );
  const expected = good.find(
    (row) => row.kind === "assertion" && row.data.assertionId === assertion,
  )!;
  const failed = bad.find(
    (row) => row.kind === "assertion" && row.data.assertionId === assertion,
  )!;
  assert.equal(expected.data.passed, true);
  assert.equal(failed.data.passed, false);
  assert.equal(failed.key[0], 54010);
  assert.equal(failed.actor, "match-source");
  assert.deepEqual(failed.data.expected, expected.data.expected);
  // This is a full cumulative receipt assertion; the most recent correction must
  // be accepted by latest-revision views and rejected as immutable by the mutant.
  const latest = expected.data.actual.at(-1),
    wrong = failed.data.actual.at(-1);
  assert.equal(latest.status, "committed");
  assert.deepEqual(latest.stream, {
    sourceId: "match-feed",
    epoch: "run",
    sourceEntityId: "match-1",
  });
  assert.equal(latest.publicationSequence, 6);
  assert.deepEqual(wrong.stream, latest.stream);
  assert.equal(wrong.publicationSequence, 6);
  assert.equal(wrong.status, "committed");
  for (const view of ["match-market", "scoreboard"]) {
    assert.equal(
      latest.targets.find(
        (target: { viewId: string }) => target.viewId === view,
      ).status,
      "accepted",
    );
    assert.equal(
      wrong.targets.find((target: { viewId: string }) => target.viewId === view)
        .reason,
      "factImmutable",
    );
  }
  assert.deepEqual(
    wrong.targets.find(
      (target: { viewId: string }) => target.viewId === "first-reported",
    ),
    latest.targets.find(
      (target: { viewId: string }) => target.viewId === "first-reported",
    ),
  );
  const timing = paused.diagnostics.generations;
  assert.equal(timing?.length, 1);
  for (const site of ["state-effect", "writer-handoff"])
    assert.ok(
      timing![0].jvm?.pauses.some(
        (pause) =>
          pause.site === site &&
          pause.requestedMillis === mode.jvmPauseMs &&
          pause.elapsedNanos >= mode.jvmPauseMs * 1e6,
      ),
    );
  assert.ok(
    timing![0].node.some(
      (pause) =>
        pause.operation === "ingress" &&
        pause.requestedMillis === mode.hostDelay &&
        pause.elapsedNanos >= mode.hostDelay * 1e6,
    ),
  );
  return { failedAssertion: assertion, timeMs: failed.key[0], mismatchIndex };
}

export async function source() {
  return {
    revision: git("rev-parse", "HEAD").toString().trim(),
    javaTree: git("rev-parse", "HEAD:zooglass").toString().trim(),
    status: git("status", "--porcelain", "--untracked-files=no").toString(),
    untracked: git(
      "ls-files",
      "--others",
      "--exclude-standard",
      "--",
      "workbench",
      "zooglass",
    ).toString(),
    workbenchSha256: await workbenchIdentity(),
    controlEvidenceSha256: sha(
      await readFile(new URL("control-evidence.ts", import.meta.url)),
    ),
    checkerSha256: sha(await readFile(new URL(import.meta.url))),
    helperSha256: sha(
      await readFile(new URL("generation-clock-check.ts", import.meta.url)),
    ),
  };
}
async function main() {
  const [prepared, output, ...extra] = process.argv.slice(2);
  assert.ok(
    prepared &&
      output &&
      extra.every((arg) => arg === "--smoke") &&
      extra.length <= 1,
    "Usage: sports-strategy-check PREPARED NEW_EVIDENCE [--smoke]",
  );
  const smoke = extra.length === 1,
    directory = resolve(output);
  await mkdir(directory);
  const provenance = await source();
  if (!smoke) {
    assert.equal(provenance.status, "");
    assert.equal(provenance.untracked, "");
  }
  const preparedDirectory = resolve(prepared),
    control = await preparation(preparedDirectory);
  assert.equal(
    git("rev-parse", `${control.manifest.revision}:zooglass`).toString().trim(),
    provenance.javaTree,
  );
  const scenario = fileURLToPath(
    new URL("../scenarios/timeline-sports/scenario.json", import.meta.url),
  );
  const captured = await captureControlInput(scenario);
  for (const [name, bytes] of Object.entries({
    "preparation.json": control.bytes,
    "strategy-original.java": control.original,
    "strategy-mutant.java": control.mutated,
    "scenario.json": captured.input.scenario.canonical,
    "runtime.json": captured.input.wire,
  }))
    await writeFile(join(directory, name), bytes, { flag: "wx" });
  const runs: Record<string, DocumentRun> = {};
  const rows = [];
  for (const name of ["normal", "mutant", "paused-mutant"] as const) {
    const variant = name === "normal" ? "normal" : "mutant";
    const run = await executeDocument(captured.input, {
      jar: join(preparedDirectory, `${variant}.jar`),
      ...(name === "paused-mutant" ? mode : {}),
      diagnosticDirectory: directory,
    });
    const bytes = JSON.stringify(run) + "\n";
    await writeFile(join(directory, `${name}.json`), bytes, { flag: "wx" });
    runs[name] = run;
    assert.equal(
      run.execution.artifactSha256,
      control.manifest.artifacts[variant],
    );
    assert.equal(run.execution.workbenchSha256, provenance.workbenchSha256);
    assert.equal(run.execution.profile, "sqlite-sports-v1");
    assert.equal(
      run.execution.configurationSha256,
      captured.input.configurationHash,
    );
    rows.push({
      name,
      sha256: sha(bytes),
      outcome: run.outcome,
      execution: run.execution,
    });
  }
  const details = checkSportsStrategyControl(
    runs.normal,
    runs.mutant,
    runs["paused-mutant"],
  );
  assert.deepEqual(await source(), provenance, "source changed during control");
  assert.deepEqual(
    (await captureControlInput(scenario)).identities,
    captured.identities,
  );
  assert.deepEqual((await preparation(preparedDirectory)).bytes, control.bytes);
  await writeFile(
    join(directory, "summary.json"),
    JSON.stringify(
      {
        format: "timeline-sports-strategy-control/v1",
        passed: true,
        qualification: !smoke,
        source: provenance,
        preparationRevision: control.manifest.revision,
        preparationSha256: sha(control.bytes),
        inputs: captured.identities,
        runs: rows,
        ...details,
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  await main();
