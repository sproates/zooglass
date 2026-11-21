import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const exec = promisify(execFile);
test("campaign CLI rejects missing conditions, invalid limits and existing create directories before running", async () => {
  const directory = await mkdtemp(join(tmpdir(), "benchmark-cli-"));
  try {
    await writeFile(join(directory, "keep.txt"), "preserve");
    for (const args of [
      ["create", join(directory, "new")],
      [
        "create",
        join(directory, "new"),
        "--conditions",
        "test",
        "--max-attempts",
        "67",
      ],
      ["create", directory, "--conditions", "test"],
      ["resume", directory, "--conditions", "test", "--unknown", "value"],
    ])
      await assert.rejects(
        exec(
          process.execPath,
          ["--import", "tsx", "src/benchmark/campaign/cli.ts", ...args],
          { timeout: 5000 },
        ),
      );
    assert.equal(
      await readFile(join(directory, "keep.txt"), "utf8"),
      "preserve",
    );
    assert.deepEqual(await readdir(directory), ["keep.txt"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
