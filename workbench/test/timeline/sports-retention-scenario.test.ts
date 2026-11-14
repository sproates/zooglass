import assert from "node:assert/strict";
import { readFile, mkdtemp, writeFile, copyFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  buildDocument,
  documentWire,
  configurationSha256,
} from "../../scenarios/timeline-sports-retention/author.js";
import { parseTimelineDocument } from "../../src/timeline/contract.js";
import { runDocument } from "../../src/timeline/run-document.js";
const directory = fileURLToPath(
  new URL("../../scenarios/timeline-sports-retention/", import.meta.url),
);
const jar = resolve(
  process.env.ZOOGLASS_SIMULATION_JAR ??
    "../zooglass/simulation-host/target/zooglass-simulation.jar",
);
test("Sports retention preserves exact configuration and bounded independent expectations", async () => {
  const doc = buildDocument();
  assert.equal(
    await readFile(join(directory, "scenario.json"), "utf8"),
    documentWire(),
  );
  assert.equal(
    createHash("sha256")
      .update(await readFile(join(directory, "runtime.json")))
      .digest("hex"),
    configurationSha256,
  );
  assert.equal(doc.actions.length, 37);
  assert.equal(doc.assertions.length, 74);
  assert.equal(doc.publications.length, 21);
  assert.doesNotThrow(() => parseTimelineDocument(JSON.stringify(doc)));
  const row = doc.assertions.find(
    (a) => a.id === "identity-boundary-scoreboard",
  )!;
  assert.equal(
    (
      row.expected as {
        snapshot: {
          status: { inputs: Record<string, { admissionFloor: number }> };
        };
      }
    ).snapshot.status.inputs["match-feed"].admissionFloor,
    2,
  );
});
test("Sports actual fact capacity, tombstones, retirement and identity boundaries satisfy authored outcomes", async (t) => {
  const diagnosticDirectory = await mkdtemp(
    join(tmpdir(), "sports-retention-run-"),
  );
  t.after(() => rm(diagnosticDirectory, { recursive: true, force: true }));
  const result = await runDocument(join(directory, "scenario.json"), { jar });
  assert.equal(result.outcome, "passed", result.message ?? "");
  assert.equal(
    result.trace
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((record) => record.kind === "assertion").length,
    74,
  );
});
test("independent fact-count and progress-floor expectations reject wrong retained state", async (t) => {
  const temp = await mkdtemp(join(tmpdir(), "sports-retention-oracle-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  await copyFile(join(directory, "runtime.json"), join(temp, "runtime.json"));
  for (const [id, field] of [
    ["tombstone-scoreboard", "facts"],
    ["identity-boundary-scoreboard", "floor"],
  ]) {
    const doc = buildDocument();
    const assertion = doc.assertions.find((a) => a.id === id)!;
    const expected = assertion.expected as {
      snapshot: {
        status: {
          fields: Record<string, { facts: { retainedCount: number } }>;
          inputs: Record<string, { admissionFloor: number }>;
        };
      };
    };
    if (field === "facts")
      expected.snapshot.status.fields.homeScore.facts.retainedCount = 15;
    else expected.snapshot.status.inputs["match-feed"].admissionFloor = 1;
    const path = join(temp, `${field}.json`);
    await writeFile(path, JSON.stringify(doc));
    const result = await runDocument(path, { jar, diagnosticDirectory: temp });
    assert.equal(result.outcome, "assertion-failed");
    assert.match(result.message ?? "", new RegExp(id));
  }
});
