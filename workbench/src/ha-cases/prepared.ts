import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { haImages } from "../ha-fixture/images.js";
export const workbenchRoot = fileURLToPath(new URL("../../", import.meta.url));
export const preparedPath = join(workbenchRoot, "dist/ha-prepared.json");
const components = ["ha-cases", "ha-fixture", "service/ha", "json"];
export async function sha256(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}
async function files(root: string, extension?: string): Promise<string[]> {
  const result: string[] = [];
  for (const item of await readdir(root, { withFileTypes: true })) {
    const path = join(root, item.name);
    if (item.isDirectory()) result.push(...(await files(path, extension)));
    else if (item.isFile() && (!extension || item.name.endsWith(extension)))
      result.push(path);
    else if (item.isSymbolicLink())
      throw new Error("Prepared artifact trees cannot contain symlinks");
  }
  return result.sort();
}
export interface PreparedIdentity {
  format: 1;
  node: string;
  platform: string;
  arch: string;
  head: string;
  images: typeof haImages;
  files: Record<string, string>;
  service: { path: string; sha256: string };
  faultAgent: null | { path: string; sha256: string; manifestSha256: string };
}
async function identity(): Promise<PreparedIdentity> {
  if (process.versions.node.split(".")[0] !== "26")
    throw new Error("Node.js 26 is required");
  const hashes: Record<string, string> = {};
  for (const component of components) {
    const sources = await files(join(workbenchRoot, "src", component), ".ts");
    for (const source of sources) {
      const output = source
        .replace(
          `${join(workbenchRoot, "src")}/`,
          `${join(workbenchRoot, "dist")}/`,
        )
        .replace(/\.ts$/, ".js");
      await access(output);
      for (const path of [source, output])
        hashes[relative(workbenchRoot, path)] = await sha256(path);
    }
  }
  const require = createRequire(import.meta.url),
    ws = dirname(require.resolve("ws/package.json"));
  for (const path of await files(ws))
    hashes[`dependency/ws/${relative(ws, path)}`] = await sha256(path);
  for (const path of [
    "package-lock.json",
    "tsconfig.json",
    "scripts/prepare-ha.js",
  ]) {
    hashes[path] = await sha256(join(workbenchRoot, path));
  }
  const service = join(workbenchRoot, "../zooglass/target/zooglass.jar");
  await access(service);
  const agent = join(
    workbenchRoot,
    "../zooglass/target/ha-fault-agent/ha-fault-agent.jar",
  );
  let faultAgent: PreparedIdentity["faultAgent"] = null;
  let hasAgent = true;
  try {
    await access(agent);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") hasAgent = false;
    else throw error;
  }
  if (hasAgent) {
    await promisify(execFile)(
      "python3",
      [
        join(workbenchRoot, "../zooglass/scripts/prepare-ha-fault-agent.py"),
        "--verify",
      ],
      { timeout: 60000 },
    );
    faultAgent = {
      path: agent,
      sha256: await sha256(agent),
      manifestSha256: await sha256(join(dirname(agent), "manifest.json")),
    };
  }
  const git = await promisify(execFile)("git", ["rev-parse", "HEAD"], {
    cwd: workbenchRoot,
    timeout: 5000,
  });
  return {
    format: 1,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    head: git.stdout.trim(),
    images: haImages,
    files: hashes,
    service: { path: service, sha256: await sha256(service) },
    faultAgent,
  };
}
export async function recordPreparation(): Promise<void> {
  await writeFile(
    preparedPath,
    JSON.stringify(await identity(), null, 2) + "\n",
  );
}
export async function verifyPreparation(
  requireAgent = false,
): Promise<PreparedIdentity> {
  const recorded = JSON.parse(
    await readFile(preparedPath, "utf8"),
  ) as PreparedIdentity;
  const actual = await identity();
  if (JSON.stringify(recorded) !== JSON.stringify(actual))
    throw new Error(
      "HA prepared artifacts or sources changed; explicitly run prepare:ha again",
    );
  if (requireAgent && !actual.faultAgent)
    throw new Error(
      "Cases 3, 7 and 8 require the explicitly prepared HA fault agent",
    );
  return actual;
}
