import { copyFile, lstat, mkdir, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Copy only public evidence. Never traverse fixture databases, keys or credentials.
export async function stageEvidence(source, destination) {
  await mkdir(destination);
  async function copy(name) {
    const file = join(source, name);
    try {
      if (!(await lstat(file)).isFile())
        throw new Error(`Expected regular evidence file: ${name}`);
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    await mkdir(dirname(join(destination, name)), { recursive: true });
    await copyFile(file, join(destination, name));
  }
  await copy("report.json");
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.isDirectory() && /^case-[0-9]{2}-[a-z0-9-]+$/.test(entry.name)) {
      await copy(join(entry.name, "observations.jsonl"));
    }
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  if (process.argv.length !== 4)
    throw new Error("Usage: ha-evidence.mjs SOURCE NEW_DESTINATION");
  await stageEvidence(process.argv[2], process.argv[3]);
}
