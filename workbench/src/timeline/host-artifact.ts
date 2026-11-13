import { buffer } from "node:stream/consumers";
import { crc32 } from "node:zlib";
import { fromBufferPromise, type Entry } from "yauzl";

const manifestPath = "META-INF/MANIFEST.MF";
const manifestLimit = 64 * 1024;
const entryLimit = 4096;
const directoryLimit = 1024 * 1024;
const directoryHeaderSize = 46;
const launcher = "org.springframework.boot.loader.launch.JarLauncher";
const host = "io.zooglass.simulation.TimelineHost";

/** Bound the scan to the single-disk, uncommented ZIP32 shape Maven produces. */
function directoryBounds(bytes: Buffer) {
  const end = bytes.length - 22;
  if (
    end < 0 ||
    bytes.readUInt32LE(end) !== 0x06054b50 ||
    bytes.readUInt32LE(end + 4) !== 0 ||
    bytes.readUInt16LE(end + 20) !== 0 ||
    (end >= 20 && bytes.readUInt32LE(end - 20) === 0x07064b50)
  )
    throw new Error("Expected a single-disk ZIP32 archive without a comment");

  const count = bytes.readUInt16LE(end + 10);
  const size = bytes.readUInt32LE(end + 12);
  const offset = bytes.readUInt32LE(end + 16);
  if (
    count !== bytes.readUInt16LE(end + 8) ||
    count < 1 ||
    count > entryLimit ||
    size < count * directoryHeaderSize ||
    size > directoryLimit ||
    offset + size !== end
  )
    throw new Error("Inconsistent or oversized JAR directory");
  return { count, offset, end };
}

async function readManifest(bytes: Buffer) {
  const { count, offset, end } = directoryBounds(bytes);
  // Compare raw entry names, as ZIP Unicode aliases are not JAR entry names.
  const archive = await fromBufferPromise(bytes, { decodeStrings: false });
  try {
    if (archive.entryCount !== count)
      throw new Error("JAR entry count changed");
    let entry: Entry | undefined;
    let cursor = offset;
    for await (const candidate of archive.eachEntry()) {
      cursor +=
        directoryHeaderSize +
        candidate.fileNameLength +
        candidate.extraFieldLength +
        candidate.fileCommentLength;
      if (cursor > end) throw new Error("Invalid JAR directory size");
      if (candidate.extraFields.some(({ id }) => id === 1))
        throw new Error("Unexpected ZIP64 entry");

      const name = candidate.fileNameRaw.toString("latin1");
      if (name.toUpperCase() !== manifestPath) continue;
      if (entry || name !== manifestPath)
        throw new Error("Ambiguous manifest entry");
      entry = candidate;
    }
    if (cursor !== end) throw new Error("Invalid JAR directory size");
    if (!entry) throw new Error("Missing manifest");
    if (
      entry.uncompressedSize < 1 ||
      entry.uncompressedSize > manifestLimit ||
      entry.compressedSize < 1 ||
      entry.compressedSize > manifestLimit
    )
      throw new Error("Manifest size outside limits");

    const local = await archive.readLocalFileHeaderPromise(entry);
    if (
      local.fileName.toString("latin1") !== manifestPath ||
      local.compressionMethod !== entry.compressionMethod ||
      local.generalPurposeBitFlag !== entry.generalPurposeBitFlag ||
      local.fileDataStart + entry.compressedSize > offset
    )
      throw new Error("Inconsistent manifest entry header");

    const manifest = await buffer(await archive.openReadStreamPromise(entry));
    if (crc32(manifest) !== entry.crc32)
      throw new Error("Manifest CRC mismatch");
    return manifest;
  } finally {
    archive.close();
  }
}

/** Read only the main section, preserving bytes across continuation lines. */
function mainAttributes(bytes: Uint8Array) {
  const attributes = new Map<string, string>();
  let name: string | undefined;
  // Header names and the two required values are ASCII. The other values are
  // opaque, and a continuation may split a multibyte UTF-8 character.
  for (const line of Buffer.from(bytes).toString("latin1").split(/\r?\n/)) {
    if (!line) return attributes;
    if (line.includes("\r")) throw new Error("Invalid manifest newline");
    if (line.startsWith(" ")) {
      if (!name) throw new Error("Unexpected manifest continuation");
      attributes.set(name, attributes.get(name)! + line.slice(1));
      continue;
    }
    const header = /^([A-Za-z0-9_-]{1,70}): (.*)$/.exec(line);
    if (!header) throw new Error("Malformed manifest header");
    name = header[1].toLowerCase();
    if (attributes.has(name))
      throw new Error(`Duplicate manifest header: ${name}`);
    attributes.set(name, header[2]);
  }
  throw new Error("Unterminated manifest main section");
}

/** Check the executable entry point before Java can run an unrelated JAR. */
export async function requireHostArtifact(bytes: Buffer) {
  try {
    const attributes = mainAttributes(await readManifest(bytes));
    if (
      attributes.get("main-class") !== launcher ||
      attributes.get("start-class") !== host ||
      attributes.has("class-path") ||
      attributes.has("launcher-agent-class")
    )
      throw new Error("Unexpected executable entry point");
  } catch (cause) {
    throw new Error(
      "Expected the ZooGlass simulation host JAR; run npm run prepare:timeline",
      { cause },
    );
  }
}
