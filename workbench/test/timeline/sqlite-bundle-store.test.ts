import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  recordBundle,
  replayBundle,
} from "../../src/timeline/artifact-bundle.js";
import { sqliteFiles } from "./sqlite-document-fixture.js";

const jar = resolve(
  process.env.ZOOGLASS_SIMULATION_JAR ??
    "../zooglass/simulation-host/target/zooglass-simulation.jar",
);

test("SQLite bundles keep diagnostic storage outside evidence even through temporary-directory aliases", async (context) => {
  const setup = await sqliteFiles();
  context.after(setup.close);
  const parent = await mkdtemp(join(tmpdir(), "sqlite-evidence-root-"));
  context.after(() => rm(parent, { recursive: true, force: true }));
  const diagnosticRoot = join(parent, "caller-supplied");
  const directory = join(parent, "bundle");
  const options = { jar, diagnosticDirectory: diagnosticRoot };
  assert.equal(
    (await recordBundle(setup.path, directory, options)).outcome,
    "passed",
  );
  assert.equal((await replayBundle(directory, options)).status, "verified");
  assert.deepEqual(
    await readdir(parent),
    ["bundle"],
    "bundle ignores caller-supplied database parent",
  );

  const alias = join(parent, "alias");
  await symlink(directory, alias, "dir");
  const original = process.env.TMPDIR;
  try {
    process.env.TMPDIR = alias;
    await assert.rejects(
      replayBundle(directory, { jar }),
      /temporary directory must be outside the evidence bundle/,
    );
  } finally {
    if (original === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = original;
  }
  assert.deepEqual((await readdir(directory)).sort(), [
    "configuration.json",
    "manifest.json",
    "run.json",
    "scenario.json",
    "trace.jsonl",
  ]);
});
