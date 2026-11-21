import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runDocument } from "../../src/timeline/run-document.js";
import { checkRecoveryControl } from "../../scripts/recovery-control.js";
import {
  readRecoveryPreparation,
  verifyRecoveryInventories,
} from "../../scripts/recovery-preparation.js";

const prepared = process.env.ZOOGLASS_RECOVERY_CONTROL;
test(
  "wrong recovery must reach the restored-state assertion, not fail startup",
  { skip: !prepared },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "recovery-control-test-"));
    try {
      const proof = await readRecoveryPreparation(resolve(prepared!));
      const path = "scenarios/timeline-static-recovery/s1/scenario.json";
      const normal = await runDocument(path, {
        jar: join(prepared!, "normal.jar"),
        diagnosticDirectory: directory,
      });
      const mutant = await runDocument(path, {
        jar: join(prepared!, "mutant.jar"),
        diagnosticDirectory: directory,
      });
      assert.equal(
        checkRecoveryControl(normal, mutant).failedAssertion,
        "restored-a",
      );
      for (const change of [
        (run: typeof mutant) => {
          run.outcome = "infrastructure-failed" as typeof run.outcome;
        },
        (run: typeof mutant) => {
          run.message = "assertion-failed: other-checkpoint";
        },
        (run: typeof mutant) => {
          run.execution.artifactSha256 = normal.execution.artifactSha256;
        },
        (run: typeof mutant) => {
          run.environment = { ...run.environment, executor: "bogus" };
        },
        (run: typeof mutant) => {
          run.trace = run.trace.replace(
            '"runtimeGeneration":2',
            '"runtimeGeneration":9',
          );
        },
      ]) {
        const corrupted = structuredClone(mutant);
        change(corrupted);
        assert.throws(() => checkRecoveryControl(normal, corrupted));
      }
      const [normalHost, mutantHost] = proof.inventories.hosts.map(
        (entries) => new Map(entries),
      );
      const [normalRuntime, mutantRuntime] = proof.inventories.runtimes.map(
        (entries) => new Map(entries),
      );
      const changed = new Map(mutantRuntime);
      const extra = [...changed.keys()].find(
        (key) =>
          key.endsWith(".class") && key !== proof.provenance.mutation.class,
      )!;
      changed.set(extra, "f".repeat(64));
      assert.throws(
        () =>
          verifyRecoveryInventories(
            normalHost,
            mutantHost,
            normalRuntime,
            changed,
            proof.provenance,
          ),
        /changed entries/,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("recovery preparation rejects extra changed classes even with revised declarations", () => {
  const entry = "BOOT-INF/lib/zooglass-0.0.1-runtime.jar";
  const changedClass = "io/zooglass/runtime/SqliteState.class";
  const normal = new Map([
    [entry, "normal-runtime"],
    ["host.class", "unchanged"],
  ]);
  const mutant = new Map([
    [entry, "mutant-runtime"],
    ["host.class", "unchanged"],
  ]);
  const runtime = new Map([
    [changedClass, "normal-class"],
    ["other.class", "unchanged"],
  ]);
  const changed = new Map([
    [changedClass, "mutant-class"],
    ["other.class", "unchanged"],
  ]);
  const provenance = {
    runtime: { entry, normal: "normal-runtime", mutant: "mutant-runtime" },
    mutation: {
      originalClassSha256: "normal-class",
      mutatedClassSha256: "mutant-class",
    },
    changedEntries: [entry],
    changedRuntimeEntries: [changedClass],
  };
  assert.doesNotThrow(() =>
    verifyRecoveryInventories(normal, mutant, runtime, changed, provenance),
  );
  changed.set("other.class", "altered");
  provenance.changedRuntimeEntries.push("other.class");
  provenance.changedRuntimeEntries.sort();
  assert.throws(
    () =>
      verifyRecoveryInventories(normal, mutant, runtime, changed, provenance),
    /unexpected artifact/,
  );
});
