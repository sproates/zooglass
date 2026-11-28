import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  options,
  Observations,
  verifyCleanup,
} from "../src/ha-cases/runner-support.js";
import { Decimal, parseJson } from "../src/json/lossless.js";

test("runner accepts only bounded fixed case selections and explicit new output destination", () => {
  assert.deepEqual(
    options(["--output", "report", "--cases", "1,3,8", "--extra-pauses"]).cases,
    [1, 3, 8],
  );
  assert.equal(options(["--output", "report"]).cases.length, 14);
  for (const args of [
    [],
    ["--output"],
    ["--output", "x", "--case", "0"],
    ["--output", "x", "--cases", "1,1"],
    ["--output", "x", "--case", "1,2"],
    ["--output", "x", "--case", "1", "--cases", "2"],
    ["--output", "x", "--unknown"],
    ["--output", "x", "--extra-pauses", "--extra-pauses"],
  ])
    assert.throws(() => options(args));
});
test("observation files preserve exact decimal evidence and reject overwrite", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ha-runner-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "observations.jsonl");
  const observations = new Observations(path);
  observations.record("committed", {
    version: new Decimal("9223372036854775807"),
  });
  assert.equal(observations.close(), 1);
  const text = await readFile(path, "utf8");
  assert.match(text, /"version":9223372036854775807/);
  const parsed = parseJson(text) as { data: { version: Decimal } };
  assert.equal(parsed.data.version.text, "9223372036854775807");
  assert.throws(() => new Observations(path), { code: "EEXIST" });
});
test("observation resource bounds fail before appending invalid evidence", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ha-runner-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const observations = new Observations(join(directory, "observations.jsonl"));
  try {
    assert.throws(() => observations.record("x".repeat(129)), /name/);
    assert.throws(
      () => observations.record("too-large", "x".repeat(16 * 1024 * 1024)),
      /bound/,
    );
    assert.equal(await verifyCleanup(directory), "no-resources-created");
  } finally {
    assert.equal(observations.close(), 0);
  }
});
