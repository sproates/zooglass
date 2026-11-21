import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { boundedFile, decode } from "../src/timeline/admission.js";
import { jarEntry, jarInventory, readJar } from "./control-evidence.js";

const sourceFile = "src/main/java/io/zooglass/runtime/SqliteState.java";
const classFile = "io/zooglass/runtime/SqliteState.class";
const before = "current = recover.apply(restored);";
const after = "current = StateImage.empty();";
export const recoveryMutation = {
  file: sourceFile,
  class: classFile,
  before,
  after,
};
const recipe = new URL("prepare-static-recovery-mutation.py", import.meta.url);
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

export function verifyRecoveryInventories(
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

export async function readRecoveryPreparation(directory: string) {
  const manifest = await boundedFile(join(directory, "preparation.json"));
  const provenance = JSON.parse(decode(manifest)) as Preparation;
  assert.equal(provenance.format, "timeline-static-recovery-preparation/v1");
  assert.match(provenance.revision, /^[0-9a-f]{40}$/);
  assert.equal(provenance.recipeSha256, digest(await readFile(recipe)));
  assert.equal(provenance.helperSha256, digest(await readFile(helper)));
  assert.equal(
    provenance.sourceArchiveSha256,
    digest(git(["archive", "--format=tar", provenance.revision, "zooglass"])),
  );
  const original = decode(
    await boundedFile(join(directory, "recovery-original.java")),
  );
  const mutated = decode(
    await boundedFile(join(directory, "recovery-mutant.java")),
  );
  assert.equal(
    original,
    git(["show", `${provenance.revision}:zooglass/${sourceFile}`]).toString(),
  );
  assert.equal(original.split(before).length, 2);
  assert.equal(mutated, original.replace(before, after));
  assert.deepEqual(provenance.mutation, {
    file: sourceFile,
    before,
    after,
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
  verifyRecoveryInventories(
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
    inventories: {
      hosts: hosts.map((value) => [...value]),
      runtimes: runtimes.map((value) => [...value]),
    },
  };
}
