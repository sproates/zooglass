import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("benchmark CLI refuses invalid rates and existing evidence before starting a service", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "benchmark-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "run.json"), "existing evidence");
  const invoke = (...args: string[]) =>
    spawnSync(
      process.execPath,
      ["--import", "tsx", "src/benchmark/cli.ts", ...args],
      { encoding: "utf8", timeout: 5000 },
    );
  const invalid = invoke("memory", "NaN", directory);
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /Usage:/);
  const existing = invoke("sqlite", "10", directory);
  assert.equal(existing.status, 1);
  assert.match(existing.stderr, /EEXIST/);
  assert.equal(
    await readFile(join(directory, "run.json"), "utf8"),
    "existing evidence",
  );
  assert.deepEqual(await readdir(directory), ["run.json"]);
});
