import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { zipSync } from "fflate";
import {
  jarEntry,
  jarInventory,
  readJar,
} from "../../scripts/control-evidence.js";

const archive = (entries: Record<string, Uint8Array>) =>
  Buffer.from(zipSync(entries, { level: 0 }));

test("control archives preserve exact entry bytes and reject absent entries", async () => {
  const bytes = Buffer.from([0, 255, 13, 10, 128]);
  const jar = archive({ "binary.class": bytes });
  assert.deepEqual(await jarEntry(jar, "binary.class"), bytes);
  assert.deepEqual(
    await jarInventory(jar),
    new Map([
      ["binary.class", createHash("sha256").update(bytes).digest("hex")],
    ]),
  );
  await assert.rejects(
    jarEntry(jar, "absent.class"),
    /missing prepared JAR entry/,
  );
});

test("control archives reject duplicate names and oversized directories", async () => {
  const duplicate = archive({
    "a.class": Buffer.from("a"),
    "b.class": Buffer.from("b"),
  });
  // Rename both the local and central-directory names without changing lengths.
  for (
    let offset = duplicate.indexOf("b.class");
    offset >= 0;
    offset = duplicate.indexOf("b.class")
  ) {
    duplicate.write("a.class", offset, "ascii");
  }
  await assert.rejects(
    jarInventory(duplicate),
    /duplicate prepared host entry/,
  );
  const entries = Object.fromEntries(
    Array.from({ length: 4097 }, (_, i) => [`${i}`, new Uint8Array()]),
  );
  await assert.rejects(
    jarInventory(archive(entries)),
    /oversized prepared JAR directory/,
  );
});

test("control archives reject an oversized declared entry before reading it", async () => {
  const jar = Buffer.from(
    zipSync({ "a.class": Buffer.from("a") }, { level: 6 }),
  );
  const central = jar.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  assert.ok(central >= 0);
  jar.writeUInt32LE(33 * 1024 * 1024, central + 24);
  await assert.rejects(jarInventory(jar), /oversized prepared JAR entry/);
});

test("prepared artifact reading preserves bytes and rejects oversized files", async () => {
  const folder = await mkdtemp(join(tmpdir(), "control-evidence-"));
  try {
    const path = join(folder, "artifact.jar");
    const bytes = archive({ "a.class": Buffer.from([0, 255]) });
    await writeFile(path, bytes);
    assert.deepEqual(await readJar(path), bytes);
    const file = await open(path, "r+");
    try {
      await file.truncate(64 * 1024 * 1024 + 1);
    } finally {
      await file.close();
    }
    await assert.rejects(
      readJar(path),
      /prepared artifact size outside limits/,
    );
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
