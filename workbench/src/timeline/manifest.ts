import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
/** Identity of timeline execution plus its legacy-parser/compiler dependency closure. */
export async function workbenchIdentity() {
  const file = fileURLToPath(import.meta.url);
  const directory = dirname(file);
  const hash = createHash("sha256");
  const extension = extname(file);
  const paths = [
    ...(await readdir(directory))
      .filter((name) => extname(name) === extension)
      .map((name) => `timeline/${name}`),
    ...(await readdir(join(directory, "../scenario")))
      .filter((name) => extname(name) === extension)
      .map((name) => `scenario/${name}`),
    `service/runtime-configuration${extension}`,
  ].sort();
  for (const name of paths) {
    const bytes = await readFile(join(directory, "..", name));
    hash
      .update(`${Buffer.byteLength(name)}:${name}${bytes.length}:`)
      .update(bytes);
  }
  return hash.digest("hex");
}
