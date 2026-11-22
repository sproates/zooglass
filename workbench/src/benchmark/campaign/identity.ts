import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  readdir,
  readFile,
  readlink,
  realpath,
  stat,
  statfs,
} from "node:fs/promises";
import {
  cpus,
  totalmem,
  hostname,
  release,
  arch,
  platform,
  loadavg,
  freemem,
} from "node:os";
import { join, relative, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
export const javaOptions = ["-Xms512m", "-Xmx512m"];
export const workbenchDirectory = fileURLToPath(
  new URL("../../../", import.meta.url),
);
export const serviceDirectory = resolve(workbenchDirectory, "../zooglass");
export const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");

type Checkpoint = () => Promise<void>;
const noCheckpoint: Checkpoint = async () => {};

export async function fileHash(path: string, checkpoint = noCheckpoint) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path, {
    highWaterMark: 1024 * 1024,
  })) {
    await checkpoint();
    hash.update(chunk);
  }
  return hash.digest("hex");
}

/** Commit installed bytes as well as the lock file. npm's in-tree bin links are ordinary inputs. */
export async function treeHash(
  root: string,
  checkpoint = noCheckpoint,
): Promise<string> {
  const base = await realpath(root);
  async function visit(path: string): Promise<string> {
    const entries = await readdir(path, { withFileTypes: true });
    const records: string[][] = [];
    for (const entry of entries.sort((a, b) =>
      Buffer.from(a.name).compare(Buffer.from(b.name)),
    )) {
      await checkpoint();
      const child = join(path, entry.name);
      if (entry.isSymbolicLink()) {
        const target = relative(base, await realpath(child));
        if (target === ".." || target.startsWith("../") || isAbsolute(target))
          throw new Error(
            "Executable input link leaves the frozen tree: " + child,
          );
        records.push([entry.name, "link", await readlink(child)]);
      } else if (entry.isDirectory()) {
        records.push([entry.name, "directory", await visit(child)]);
      } else if (entry.isFile()) {
        records.push([entry.name, "file", await fileHash(child, checkpoint)]);
      } else throw new Error("Unsupported executable input: " + child);
    }
    return digest(JSON.stringify(records));
  }
  return visit(base);
}

export async function executionIdentity(
  directory: string,
  checkpoint = noCheckpoint,
) {
  if (!["darwin", "linux"].includes(process.platform))
    throw new Error(
      "Campaign execution supports macOS and Linux local filesystems",
    );
  for (const name of [
    "JAVA_TOOL_OPTIONS",
    "JDK_JAVA_OPTIONS",
    "_JAVA_OPTIONS",
    "SPRING_APPLICATION_JSON",
    "NODE_OPTIONS",
  ])
    if (process.env[name])
      throw new Error(`Remove ${name} before a frozen campaign`);
  const java = process.env.JAVA_HOME
    ? join(process.env.JAVA_HOME, "bin/java")
    : "java";
  const version = await exec(java, ["-version"], { timeout: 5000 });
  const lock = await readFile(
    join(workbenchDirectory, "package-lock.json"),
    "utf8",
  );
  const storage = await stat(directory, { bigint: true });
  const filesystem = await statfs(directory, { bigint: true });
  const runtimeEnvironment = Object.entries(process.env)
    .filter(
      ([name]) =>
        name !== "ZOOGLASS_CAMPAIGN_LOCK_FD" &&
        /^(SPRING_|ZOOGLASS_|SERVER_|JDK_|JAVA_|WS_|ESBUILD_|TSX_|LANG$|LC_|TZ$)/.test(
          name,
        ),
    )
    .sort(([a], [b]) => a.localeCompare(b, "en"));
  return {
    storageDevice: String(storage.dev),
    filesystemType: String(filesystem.type),
    runtimeEnvironment: digest(JSON.stringify(runtimeEnvironment)),
    serviceJar: await fileHash(
      join(serviceDirectory, "target/zooglass.jar"),
      checkpoint,
    ),
    driver: await treeHash(join(workbenchDirectory, "src"), checkpoint),
    scripts: await treeHash(join(workbenchDirectory, "scripts"), checkpoint),
    packageManifest: await fileHash(
      join(workbenchDirectory, "package.json"),
      checkpoint,
    ),
    tsconfig: await fileHash(
      join(workbenchDirectory, "tsconfig.json"),
      checkpoint,
    ),
    dependencyLock: digest(lock),
    dependencies: await treeHash(
      join(workbenchDirectory, "node_modules"),
      checkpoint,
    ),
    node: process.version,
    jvm: (version.stdout + version.stderr).trim(),
    javaExecutable: java,
    javaOptions: JSON.stringify(javaOptions),
    operatingSystem: `${platform()}/${release()}/${arch()}`,
    hardware: digest(
      JSON.stringify({
        host: hostname(),
        cpus: cpus().map((cpu) => cpu.model),
        memory: totalmem(),
      }),
    ),
    hardwareDescription: `${cpus().length} logical CPUs; ${cpus()[0]?.model}; ${totalmem()} bytes RAM`,
  };
}

export function hostConditions(description: string) {
  if (!description.trim())
    throw new Error(
      "Describe power, thermal state, competing load and storage conditions for this session",
    );
  return {
    description,
    loadAverage: JSON.stringify(loadavg()),
    freeMemoryBytes: String(freemem()),
    memoryPressure: "not measured; free memory is not memory pressure",
    limitation:
      "Shared host; background load and filesystem cache can vary between sessions",
  };
}
