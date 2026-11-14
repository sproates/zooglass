import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import test from "node:test";
import {
  captureControlInput,
  checkClockControl,
  checkRecoveryClockControl,
  verifyClockInventories,
} from "../../scripts/generation-clock-check.js";
import type { DocumentRun } from "../../src/timeline/campaign-checks.js";
import { files } from "./document-fixture.js";

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

test("recovery clock control requires the recovery assertion, not a later age failure", () => {
  const normal = outcome("passed");
  const wrong = outcome(
    "assertion-failed",
    "assertion-failed: duplicate-keeps-unknown",
  );
  assert.throws(
    () => checkRecoveryClockControl(normal, wrong, wrong),
    /assertion-failed: unknown-after-recovery/,
  );
});

test("control provenance can distinguish a rewritten source input from retained canonical semantics", async () => {
  const fixture = await files();
  try {
    const original = await captureControlInput(fixture.path);
    await writeFile(fixture.path, `${await readFile(fixture.path, "utf8")}\n`);
    const rewritten = await captureControlInput(fixture.path);
    assert.equal(
      original.identities.scenarioSha256,
      rewritten.identities.scenarioSha256,
    );
    assert.equal(
      original.identities.configurationSha256,
      rewritten.identities.configurationSha256,
    );
    assert.notEqual(
      original.identities.scenarioSourceSha256,
      rewritten.identities.scenarioSourceSha256,
    );
  } finally {
    await fixture.close();
  }
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
