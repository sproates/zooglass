import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
/** Identity of the actual proof modules, separate from nonsemantic host delays/pacing. */
export async function workbenchIdentity() {
  const file = fileURLToPath(import.meta.url);
  const directory = dirname(file);
  const hash = createHash("sha256");
  for (const name of (await readdir(directory))
    .filter((name) => extname(name) === extname(file))
    .sort()) {
    const bytes = await readFile(join(directory, name));
    hash
      .update(`${Buffer.byteLength(name)}:${name}${bytes.length}:`)
      .update(bytes);
  }
  return hash.digest("hex");
}
