import assert from "node:assert/strict";
import test from "node:test";
import {
  checkClockControl,
  verifyClockInventories,
} from "../../scripts/generation-clock-check.js";
import type { DocumentRun } from "../../src/timeline/campaign-checks.js";

function outcome(outcome: DocumentRun["outcome"], message?: string) {
  return { outcome, message } as DocumentRun;
}

test("clock control rejects a mutant that fails before reaching the scenario oracle", () => {
  const normal = outcome("passed");
  const infrastructure = outcome(
    "infrastructure-failed",
    "invalid runtime identity",
  );
  assert.throws(
    () => checkClockControl(normal, infrastructure, infrastructure),
    /mutant must fail semantically/,
  );
});

test("clock control rejects a mutant that fails a different scenario assertion", () => {
  const normal = outcome("passed");
  const wrong = outcome(
    "assertion-failed",
    "assertion-failed: no-receipt-while-stopped",
  );
  assert.throws(
    () => checkClockControl(normal, wrong, wrong),
    /assertion-failed: fresh-after-restart/,
  );
});

test("clock control compares actual JAR entries before trusting mutation provenance", () => {
  const clock =
    "BOOT-INF/classes/io/zooglass/runtime/ControlledReceiptClock.class";
  const other = "BOOT-INF/classes/io/zooglass/simulation/TimelineHost.class";
  const runtime = "BOOT-INF/lib/zooglass-0.1.0-SNAPSHOT-runtime.jar";
  const normal = new Map([
    [clock, "original"],
    [other, "same"],
    [runtime, "shared"],
  ]);
  const mutant = new Map([
    [clock, "mutated"],
    [other, "same"],
    [runtime, "shared"],
  ]);
  const provenance = {
    mutation: {
      originalClassSha256: "original",
      mutatedClassSha256: "mutated",
    },
    runtime: { entry: runtime, sha256: "shared" },
    changedEntries: [clock],
  };

  verifyClockInventories(normal, mutant, provenance);
  assert.throws(
    () =>
      verifyClockInventories(normal, mutant, {
        ...provenance,
        runtime: { entry: runtime, sha256: "forged" },
      }),
    /embedded runtime identity mismatch/,
  );
  mutant.set(other, "changed");
  assert.throws(
    () => verifyClockInventories(normal, mutant, provenance),
    /actual changed host entries do not match preparation/,
  );
  assert.throws(
    () =>
      verifyClockInventories(normal, mutant, {
        ...provenance,
        changedEntries: [clock, other],
      }),
    /unexpected host content changes/,
  );
});
