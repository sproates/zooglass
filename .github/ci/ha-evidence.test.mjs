import test from "node:test";
import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stageEvidence } from "./ha-evidence.mjs";

test("HA upload stages only reports without traversing private fixture directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "ha-evidence-"));
  const source = join(root, "source"),
    destination = join(root, "public");
  const fixture = join(source, "case-01-example", "fixture");
  await mkdir(fixture, { recursive: true });
  await writeFile(join(source, "report.json"), "report");
  await writeFile(
    join(source, "case-01-example", "observations.jsonl"),
    "observation",
  );
  await writeFile(join(fixture, "secret"), "must never be published");
  await mkdir(join(source, "case-02-incomplete"));
  await symlink(fixture, join(source, "case-03-symlink"));
  await chmod(fixture, 0);
  try {
    await stageEvidence(source, destination);
    assert.deepEqual((await readdir(destination)).sort(), [
      "case-01-example",
      "report.json",
    ]);
    assert.deepEqual(await readdir(join(destination, "case-01-example")), [
      "observations.jsonl",
    ]);
    assert.equal(
      await readFile(join(destination, "report.json"), "utf8"),
      "report",
    );
    assert.equal(
      await readFile(
        join(destination, "case-01-example", "observations.jsonl"),
        "utf8",
      ),
      "observation",
    );
    await assert.rejects(stageEvidence(source, destination), {
      code: "EEXIST",
    });
  } finally {
    await chmod(fixture, 0o700);
    await rm(root, { recursive: true, force: true });
  }
});
