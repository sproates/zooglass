import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { workbenchIdentity } from "../src/timeline/manifest.js";

export const workbench = fileURLToPath(new URL("../", import.meta.url));
export const staticCases = [
  "live-match",
  "late-update",
  "bursty-updates",
  "sequence-gap",
  "shared-sequence-across-entities",
  "mixed-modes",
] as const;
export const digest = (bytes: string | Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
export const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: workbench, encoding: "utf8" }).trim();
export const writeEvidence = (path: string, value: unknown) =>
  writeFile(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });

/** Pin all tracked runner/fixture sources, not just executor identity. */
export async function cleanSource() {
  assert.equal(
    git("status", "--porcelain", "--untracked-files=no"),
    "",
    "qualification requires a clean committed checkout",
  );
  assert.equal(
    git(
      "ls-files",
      "--others",
      "--exclude-standard",
      "--",
      "src",
      "scripts",
      "scenarios",
      "test",
      "package.json",
      "package-lock.json",
      "../zooglass",
    ),
    "",
    "qualification has untracked relevant files",
  );
  const paths = git(
    "ls-files",
    "--",
    "scripts",
    "scenarios/timeline-static",
    "package.json",
    "package-lock.json",
  ).split("\n");
  return {
    revision: git("rev-parse", "HEAD"),
    javaSourceTree: git("rev-parse", "HEAD:zooglass"),
    workbenchSha256: await workbenchIdentity(),
    files: await Promise.all(
      paths.map(async (path) => ({
        path,
        sha256: digest(await readFile(join(workbench, path))),
      })),
    ),
  };
}
