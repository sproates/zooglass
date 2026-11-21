import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { cleanSource, digest, git, workbench } from "./static-evidence.js";
export { digest, git, workbench, writeEvidence } from "./static-evidence.js";
export const recoveryCases = ["m1", "m2", "s1", "s2", "s3", "b1"] as const;
export async function cleanRecoverySource() {
  const source = await cleanSource();
  const paths = git(
    "ls-files",
    "--",
    "scenarios/timeline-static-recovery",
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
