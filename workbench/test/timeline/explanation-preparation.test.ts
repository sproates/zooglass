import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  explanationMutation,
  mutateExplanationReason,
  verifyExplanationInventories,
} from "../../scripts/explanation-preparation.js";

// Import the preparation function and compare its bytes; never call a Java build.
test("reason mutation changes exactly the older-sequence reason in real production source", async () => {
  const source = new URL(
    `../../../zooglass/${explanationMutation.file}`,
    import.meta.url,
  );
  const recipe = new URL(
    "../../scripts/prepare-explanation-mutation.py",
    import.meta.url,
  );
  const original = await readFile(source, "utf8");
  const mutated = execFileSync(
    "python3",
    [
      "-c",
      `
import pathlib, runpy, sys
recipe = runpy.run_path(sys.argv[1])
source = pathlib.Path(sys.argv[2]).read_bytes()
sys.stdout.buffer.write(recipe['mutate'](source))
`,
      fileURLToPath(recipe),
      fileURLToPath(source),
    ],
    { encoding: "utf8" },
  );
  assert.equal(mutated, mutateExplanationReason(original));
  const site = original.indexOf(explanationMutation.before);
  assert.equal(mutated.slice(0, site), original.slice(0, site));
  assert.equal(
    mutated.slice(site + explanationMutation.after.length),
    original.slice(site + explanationMutation.before.length),
  );
  assert.equal(mutated.split(explanationMutation.before).length, 1);
  assert.equal(
    mutated.split(explanationMutation.after).length,
    original.split(explanationMutation.after).length + 1,
  );
  assert.throws(
    () => mutateExplanationReason(original + original),
    /mutation site changed/,
  );
  assert.throws(
    () => mutateExplanationReason(mutated),
    /mutation site changed/,
  );
});

function inventories() {
  const entry = "BOOT-INF/lib/zooglass-0.1.0-SNAPSHOT-runtime.jar";
  const normal = new Map([
    [entry, "normal-runtime"],
    ["BOOT-INF/classes/Host.class", "unchanged-host"],
  ]);
  const mutant = new Map(normal).set(entry, "mutant-runtime");
  const runtime = new Map([
    [explanationMutation.class, "old-class"],
    ["io/zooglass/runtime/ViewCoordinator.class", "unchanged-runtime"],
  ]);
  const changed = new Map(runtime).set(explanationMutation.class, "new-class");
  const provenance = {
    runtime: { entry, normal: "normal-runtime", mutant: "mutant-runtime" },
    mutation: {
      originalClassSha256: "old-class",
      mutatedClassSha256: "new-class",
    },
    changedEntries: [entry],
    changedRuntimeEntries: [explanationMutation.class],
  };
  return { normal, mutant, runtime, changed, provenance };
}

test("reason preparation accepts only the strategy class and its containing runtime JAR", () => {
  const { normal, mutant, runtime, changed, provenance } = inventories();
  assert.doesNotThrow(() =>
    verifyExplanationInventories(normal, mutant, runtime, changed, provenance),
  );
  assert.throws(
    () =>
      verifyExplanationInventories(normal, mutant, runtime, changed, {
        ...provenance,
        runtime: { ...provenance.runtime, mutant: "stale-runtime" },
      }),
    /embedded runtime identity mismatch/,
  );
  assert.throws(() =>
    verifyExplanationInventories(normal, mutant, runtime, changed, {
      ...provenance,
      mutation: { ...provenance.mutation, mutatedClassSha256: "wrong-class" },
    }),
  );
  assert.throws(
    () =>
      verifyExplanationInventories(normal, mutant, runtime, runtime, {
        ...provenance,
        changedRuntimeEntries: [],
      }),
    /unexpected artifact content changes/,
  );
});

test("reason preparation rejects extra, missing and undeclared implementation changes", () => {
  const { normal, mutant, runtime, changed, provenance } = inventories();
  const extra = "io/zooglass/runtime/ViewCoordinator.class";
  assert.throws(
    () =>
      verifyExplanationInventories(
        normal,
        mutant,
        runtime,
        new Map(changed).set(extra, "changed"),
        {
          ...provenance,
          changedRuntimeEntries: [extra, explanationMutation.class].sort(),
        },
      ),
    /unexpected artifact content changes/,
  );
  assert.throws(
    () =>
      verifyExplanationInventories(
        normal,
        new Map(mutant).set("BOOT-INF/classes/Host.class", "changed"),
        runtime,
        changed,
        provenance,
      ),
    /changed entries do not match/,
  );
  const missing = new Map(changed);
  missing.delete(extra);
  assert.throws(
    () =>
      verifyExplanationInventories(
        normal,
        mutant,
        runtime,
        missing,
        provenance,
      ),
    /layouts differ/,
  );
  const secondRuntime = new Map(normal).set(
    "BOOT-INF/lib/zooglass-stale-runtime.jar",
    "stale",
  );
  assert.throws(
    () =>
      verifyExplanationInventories(
        secondRuntime,
        new Map(mutant),
        runtime,
        changed,
        provenance,
      ),
    /expected one embedded production runtime/,
  );
});
