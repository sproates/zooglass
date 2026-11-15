import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { captureSource as clockSource } from "../../scripts/generation-clock-check.js";
import { captureSource as fleetSource } from "../../scripts/fleet-strategy-check.js";
import { source as sportsSource } from "../../scripts/sports-strategy-check.js";

// This test runs in its own Node test process. No checkout files are changed.
test("control provenance detects changes to the shared helper without reinterpreting old hashes", async (t) => {
  const captureAll = () =>
    Promise.all([clockSource(), fleetSource(), sportsSource()]);
  const original = await captureAll();
  const readFile = fs.readFile;
  const helper = new URL("../../scripts/control-evidence.ts", import.meta.url)
    .href;
  t.mock.method(
    fs,
    "readFile",
    async (...args: Parameters<typeof readFile>) => {
      const bytes = await readFile(...args);
      if (args[0] instanceof URL && args[0].href === helper) {
        return Buffer.concat([
          Buffer.from(bytes),
          Buffer.from("\n// changed helper\n"),
        ]);
      }
      return bytes;
    },
  );
  syncBuiltinESMExports();
  try {
    const changed = await captureAll();
    for (let i = 0; i < original.length; i++) {
      assert.notEqual(
        changed[i].controlEvidenceSha256,
        original[i].controlEvidenceSha256,
      );
      assert.equal(changed[i].checkerSha256, original[i].checkerSha256);
      assert.equal(changed[i].workbenchSha256, original[i].workbenchSha256);
    }
    assert.equal(
      changed[1].sharedCheckerSha256,
      original[1].sharedCheckerSha256,
    );
    assert.equal(changed[2].helperSha256, original[2].helperSha256);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});
