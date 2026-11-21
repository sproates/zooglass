import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { boundedFile, decode } from "../src/timeline/admission.js";
import { jarEntry, jarInventory, readJar } from "./control-evidence.js";

export const explanationMutation = {
  file: "src/main/java/io/zooglass/strategy/update/LatestBySequence.java",
  class: "io/zooglass/strategy/update/LatestBySequence.class",
  before: "FieldUpdate.Reason.LATEST_OLDER",
  after: "FieldUpdate.Reason.LATEST_EQUAL",
};
const recipe = new URL("prepare-explanation-mutation.py", import.meta.url);
const helper = new URL("prepare-generation-clock-mutation.py", import.meta.url);
const checkout = fileURLToPath(new URL("../..", import.meta.url));
const digest = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");
const git = (args: string[]) =>
  execFileSync("git", args, {
    cwd: checkout,
    timeout: 15_000,
    maxBuffer: 16 * 1024 * 1024,
  });

export type ExplanationPreparation = {
  format: string;
  revision: string;
  javaSourceTree: string;
  sourceArchiveSha256: string;
  recipeSha256: string;
  helperSha256: string;
  java: string;
  commands: string[][];
  mutation: Record<string, string>;
  runtime: { entry: string; normal: string; mutant: string };
  artifacts: { normal: string; mutant: string };
  changedEntries: string[];
  changedRuntimeEntries: string[];
};

export function mutateExplanationReason(original: string) {
  const { before, after } = explanationMutation;
  assert.equal(
    original.split(before).length,
    2,
    "LatestBySequence reason mutation site changed",
  );
  return original.replace(before, after);
}

function changedEntries(
  normal: ReadonlyMap<string, string>,
  mutant: ReadonlyMap<string, string>,
  declared: string[],
  metadata: string,
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
    changed.filter((key) => key !== metadata),
    [required],
    "unexpected artifact content changes",
  );
}

/** No implementation class besides LatestBySequence may change in the two prepared hosts. */
export function verifyExplanationInventories(
  normal: ReadonlyMap<string, string>,
  mutant: ReadonlyMap<string, string>,
  normalRuntime: ReadonlyMap<string, string>,
  mutantRuntime: ReadonlyMap<string, string>,
  provenance: Pick<
    ExplanationPreparation,
    "runtime" | "mutation" | "changedEntries" | "changedRuntimeEntries"
  >,
) {
  const embedded = [...normal.keys()].filter((key) =>
    /^BOOT-INF\/lib\/zooglass-[\w.-]+-runtime\.jar$/.test(key),
  );
  assert.deepEqual(
    embedded,
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
    explanationMutation.class,
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
    normalRuntime.get(explanationMutation.class),
    provenance.mutation.originalClassSha256,
  );
  assert.equal(
    mutantRuntime.get(explanationMutation.class),
    provenance.mutation.mutatedClassSha256,
  );
}

/** Read and verify already prepared artifacts. This helper never runs a Java build. */
export async function readExplanationPreparation(directory: string) {
  const root = resolve(directory);
  const manifest = await boundedFile(join(root, "preparation.json"));
  const provenance = JSON.parse(decode(manifest)) as ExplanationPreparation;
  assert.equal(provenance.format, "timeline-explanation-preparation/v1");
  assert.match(provenance.revision, /^[0-9a-f]{40}$/);
  assert.equal(
    provenance.javaSourceTree,
    git(["rev-parse", `${provenance.revision}:zooglass`])
      .toString()
      .trim(),
  );
  assert.equal(provenance.recipeSha256, digest(await readFile(recipe)));
  assert.equal(provenance.helperSha256, digest(await readFile(helper)));
  assert.equal(
    provenance.sourceArchiveSha256,
    digest(git(["archive", "--format=tar", provenance.revision, "zooglass"])),
  );
  assert.equal(typeof provenance.java, "string");
  assert.ok(provenance.java.length > 0);
  assert.equal(
    provenance.commands.length,
    4,
    "expected two isolated runtime and host builds",
  );
  let repository: string | undefined;
  provenance.commands.forEach((command, index) => {
    assert.ok(Array.isArray(command));
    assert.match(command[2], /^-Dmaven\.repo\.local=\/.+\/maven-repository$/);
    repository ??= command[2];
    assert.equal(
      command[2],
      repository,
      "builds must share their isolated Maven repository",
    );
    assert.deepEqual(command, [
      "./mvnw",
      "--batch-mode",
      repository,
      ...(index % 2 === 0
        ? ["-DskipTests", "clean", "install"]
        : ["-f", "simulation-host/pom.xml", "-DskipTests", "clean", "package"]),
    ]);
  });
  const original = decode(
    await boundedFile(join(root, "reason-original.java")),
  );
  const mutated = decode(await boundedFile(join(root, "reason-mutant.java")));
  assert.equal(
    original,
    git([
      "show",
      `${provenance.revision}:zooglass/${explanationMutation.file}`,
    ]).toString(),
  );
  assert.equal(mutated, mutateExplanationReason(original));
  assert.deepEqual(provenance.mutation, {
    ...explanationMutation,
    originalSha256: digest(original),
    mutatedSha256: digest(mutated),
    originalClassSha256: provenance.mutation.originalClassSha256,
    mutatedClassSha256: provenance.mutation.mutatedClassSha256,
  });
  const artifacts = {
    normal: join(root, "normal.jar"),
    mutant: join(root, "mutant.jar"),
  };
  const names = ["normal", "mutant"] as const;
  const jars = await Promise.all(names.map((name) => readJar(artifacts[name])));
  for (const [index, name] of names.entries())
    assert.equal(
      digest(jars[index]),
      provenance.artifacts[name],
      `${name} artifact identity mismatch`,
    );
  const hosts = await Promise.all(jars.map(jarInventory));
  const runtimeBytes = await Promise.all(
    jars.map((jar) => jarEntry(jar, provenance.runtime.entry)),
  );
  for (const [index, name] of names.entries()) {
    assert.equal(digest(runtimeBytes[index]), provenance.runtime[name]);
    assert.deepEqual(
      await readJar(join(root, `${name}-runtime.jar`)),
      runtimeBytes[index],
      "standalone and embedded runtime differ",
    );
  }
  const runtimes = await Promise.all(runtimeBytes.map(jarInventory));
  verifyExplanationInventories(
    hosts[0],
    hosts[1],
    runtimes[0],
    runtimes[1],
    provenance,
  );
  return {
    provenance,
    manifest,
    original,
    mutated,
    artifacts,
    inventories: {
      hosts: hosts.map((value) => [...value]),
      runtimes: runtimes.map((value) => [...value]),
    },
  };
}
