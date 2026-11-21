import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  lstat,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type { Artifact } from "./model.js";

export const digest = (data: string | Buffer) =>
  createHash("sha256").update(data).digest("hex");

function recordBytes(data: unknown) {
  return (
    JSON.stringify({ data, sha256: digest(JSON.stringify(data)) }, null, 2) +
    "\n"
  );
}
export const recordHash = (data: unknown) => digest(recordBytes(data));

export async function readRecord<T>(path: string): Promise<T> {
  if (!(await lstat(path)).isFile())
    throw new Error(`Invalid campaign file: ${path}`);
  const bytes = await readFile(path, "utf8");
  const { data } = JSON.parse(bytes);
  if (data === undefined || bytes !== recordBytes(data))
    throw new Error(`Invalid campaign record checksum: ${path}`);
  return data;
}

/** Same-directory publication; the previous record survives a runner crash mid-write. */
export async function writeRecord(
  path: string,
  data: unknown,
  replace = false,
) {
  const temp = path + ".pending";
  // Only our exclusive owner creates these temporary files. Never follow a stale link.
  await rm(temp, { force: true });
  await writeFile(temp, recordBytes(data), {
    flag: "wx",
  });
  if (replace) await rename(temp, path);
  else {
    await link(temp, path);
    await rm(temp);
  }
}

export async function exists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function inventory(
  directory: string,
  names: readonly string[],
  sealed: boolean,
  checkpoint: () => Promise<void>,
): Promise<Artifact[]> {
  const expected = [...names].sort();
  if (
    new Set(names).size !== names.length ||
    names.some(
      (name) =>
        (!/^[A-Za-z0-9][A-Za-z0-9_-]*\.[A-Za-z0-9]+$/.test(name) &&
          ![
            "store.sqlite-wal",
            "store.sqlite-shm",
            "store.sqlite-journal",
          ].includes(name)) ||
        ["input.json", "completed.json"].includes(name),
    )
  ) {
    throw new Error("Invalid campaign artifact names");
  }
  // A crash after link-before-unlink can leave a second name for the identical seal.
  const staged = join(directory, "completed.json.pending");
  if (sealed && (await exists(staged))) {
    const temp = await lstat(staged, { bigint: true });
    const final = await lstat(join(directory, "completed.json"), {
      bigint: true,
    });
    if (temp.dev !== final.dev || temp.ino !== final.ino || !temp.isFile())
      throw new Error("Unexpected pending artifact in sealed directory");
    await rm(staged);
  }
  const actual = (await readdir(directory))
    .filter(
      (name) => name !== "input.json" && !(sealed && name === "completed.json"),
    )
    .sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(`Unexpected artifact inventory: ${directory}`);
  const result: Artifact[] = [];
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  for (const name of expected) {
    const path = join(directory, name);
    const file = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = await file.stat();
      if (!stat.isFile()) throw new Error(`Invalid campaign artifact: ${name}`);
      const hash = createHash("sha256");
      let bytes = 0;
      for (;;) {
        await checkpoint();
        const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        bytes += bytesRead;
        hash.update(buffer.subarray(0, bytesRead));
      }
      if (bytes !== stat.size)
        throw new Error(`Artifact size changed: ${name}`);
      result.push({ name, bytes, sha256: hash.digest("hex") });
    } finally {
      await file.close();
    }
  }
  return result;
}
