import assert from "node:assert/strict";
import test from "node:test";
import {
  checkFleetStrategyControl,
  verifyFleetInventories,
} from "../../scripts/fleet-strategy-check.js";
import type { DocumentRun } from "../../src/timeline/campaign-checks.js";

test("fleet strategy control requires late-input semantic failure", () => {
  const normal = { outcome: "passed" } as DocumentRun;
  for (const outcome of ["passed", "unsupported", "infrastructure-failed"])
    assert.throws(
      () =>
        checkFleetStrategyControl(
          normal,
          { outcome } as DocumentRun,
          { outcome } as DocumentRun,
        ),
      /mutant must fail semantically/,
    );
  const wrong = {
    outcome: "assertion-failed",
    message: "assertion-failed: receipts-60",
  } as DocumentRun;
  assert.throws(
    () => checkFleetStrategyControl(normal, wrong, wrong),
    /frames-240/,
  );
});

test("fleet strategy provenance checks nested production class delta", () => {
  const runtime = "BOOT-INF/lib/zooglass-0.1.0-SNAPSHOT-runtime.jar";
  const strategy = "io/zooglass/strategy/update/LatestBySequence.class";
  const other = "io/zooglass/runtime/ViewTransitions.class";
  const normal = new Map([
    [runtime, "normal-runtime"],
    ["host.class", "same"],
  ]);
  const mutant = new Map([
    [runtime, "mutant-runtime"],
    ["host.class", "same"],
  ]);
  const normalRuntime = new Map([
    [strategy, "sequence"],
    [other, "same"],
  ]);
  const mutantRuntime = new Map([
    [strategy, "arrival"],
    [other, "same"],
  ]);
  const provenance = {
    runtime: {
      entry: runtime,
      normal: "normal-runtime",
      mutant: "mutant-runtime",
    },
    mutation: {
      originalClassSha256: "sequence",
      mutatedClassSha256: "arrival",
    },
    changedEntries: [runtime],
    changedRuntimeEntries: [strategy],
  };
  verifyFleetInventories(
    normal,
    mutant,
    normalRuntime,
    mutantRuntime,
    provenance,
  );
  assert.throws(
    () =>
      verifyFleetInventories(normal, mutant, normalRuntime, mutantRuntime, {
        ...provenance,
        runtime: { ...provenance.runtime, mutant: "forged" },
      }),
    /embedded runtime identity mismatch/,
  );
  mutantRuntime.set(other, "changed");
  assert.throws(
    () =>
      verifyFleetInventories(
        normal,
        mutant,
        normalRuntime,
        mutantRuntime,
        provenance,
      ),
    /actual changed entries/,
  );
  assert.throws(
    () =>
      verifyFleetInventories(normal, mutant, normalRuntime, mutantRuntime, {
        ...provenance,
        changedRuntimeEntries: [other, strategy].sort(),
      }),
    /unexpected artifact content/,
  );
  mutantRuntime.set(other, "same");
  mutant.set("host.class", "changed");
  assert.throws(
    () =>
      verifyFleetInventories(
        normal,
        mutant,
        normalRuntime,
        mutantRuntime,
        provenance,
      ),
    /actual changed entries/,
  );
  assert.throws(
    () =>
      verifyFleetInventories(normal, mutant, normalRuntime, mutantRuntime, {
        ...provenance,
        changedEntries: [runtime, "host.class"].sort(),
      }),
    /unexpected artifact content/,
  );
});
