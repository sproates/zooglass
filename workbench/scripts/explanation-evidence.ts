import { boundedFile, decode } from "../src/timeline/file-input.js";
import { jsonLimits } from "../src/timeline/json.js";
import assert from "node:assert/strict";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { cleanSource, digest, git, workbench } from "./static-evidence.js";
export { digest, workbench, writeEvidence } from "./static-evidence.js";

export async function explanationSource() {
  const source = await cleanSource();
  const paths = git(
    "ls-files",
    "--",
    "src/explanation",
    "scenarios/timeline-explanations",
  ).split("\n");
  return {
    ...source,
    files: [
      ...source.files,
      ...(await Promise.all(
        paths.map(async (path) => ({
          path,
          sha256: digest(await readFile(join(workbench, path))),
        })),
      )),
    ],
  };
}

/** A small regular-file inventory; links and oversized evidence are rejected. */
export async function explanationInventory(directory: string) {
  const entries: { path: string; bytes: number; sha256: string }[] = [];
  let directories = 0;
  async function walk(relative: string) {
    assert.ok(
      ++directories <= 64 && relative.split("/").length <= 8,
      "evidence directory limit",
    );
    for (const name of (await readdir(join(directory, relative))).sort()) {
      if (!relative && ["summary.json", "audit.json"].includes(name)) continue;
      const path = relative ? `${relative}/${name}` : name;
      const full = join(directory, path),
        info = await lstat(full);
      if (info.isDirectory()) {
        await walk(path);
        continue;
      }
      assert.ok(
        info.isFile(),
        "evidence must contain regular files, not links",
      );
      assert.ok(
        entries.length < 128 && info.size <= 16 * 1024 * 1024,
        "evidence inventory limit",
      );
      const bytes = await readFile(full);
      entries.push({ path, bytes: bytes.length, sha256: digest(bytes) });
    }
  }
  await walk("");
  return entries;
}

/** Bound audit metadata before parsing, including the manifest outside its own inventory. */
export async function readExplanationJson<T>(path: string): Promise<T> {
  const info = await lstat(path);
  assert.ok(info.isFile(), "audit JSON requires a regular file, not a symlink");
  assert.ok(info.size <= jsonLimits.bytes, "audit JSON byte limit");
  return JSON.parse(decode(await boundedFile(path))) as T;
}
