import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { closeSync, openSync, writeSync } from "node:fs";
import { lstat, mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { boundedFile, decode, loadDocument } from "./admission.js";
import { encodeJson, parseJson, type Json } from "./json.js";
import { parseReplay, replaySaved } from "./replay-document.js";
import { executeDocument, type DocumentOptions } from "./run-document.js";
import { integer, object, text } from "./validation.js";

const files = [
  "scenario.json",
  "configuration.json",
  "trace.jsonl",
  "run.json",
] as const;
const versions = {
  scenario: "timeline-simulation/v1",
  trace: "timeline-trace/v1",
  scheduler: "time-round-phase-ordinal/v1",
  randomness: "sha256-length-prefixed/v1",
  protocol: 1,
};
const hash = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");
const same = (a: Json, b: Json, label: string) => {
  if (encodeJson(a) !== encodeJson(b))
    throw new Error(`invalid-bundle: ${label} mismatch`);
};
function provenance() {
  const cwd = fileURLToPath(new URL("../../..", import.meta.url));
  try {
    return {
      revision: execFileSync("git", ["rev-parse", "HEAD"], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim(),
      trackedChanges:
        execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
          cwd,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim().length > 0,
    };
  } catch {
    return { revision: null, trackedChanges: null };
  }
}

/** Exclusive destination; trace is appended live and manifest is the last completeness marker. */
export async function recordBundle(
  scenarioPath: string,
  directory: string,
  options: Omit<DocumentOptions, "observeRecord" | "admitReplay">,
) {
  await mkdir(directory);
  let traceFile: number | undefined;
  try {
    const input = await loadDocument(scenarioPath);
    await writeFile(
      join(directory, "scenario.json"),
      input.scenario.canonical,
      { flag: "wx" },
    );
    await writeFile(join(directory, "configuration.json"), input.wire, {
      flag: "wx",
    });
    traceFile = openSync(join(directory, "trace.jsonl"), "wx");
    const result = await executeDocument(input, {
      ...options,
      observeRecord: (line) => {
        const bytes = Buffer.from(line);
        let offset = 0;
        while (offset < bytes.length) {
          const count = writeSync(
            traceFile!,
            bytes,
            offset,
            bytes.length - offset,
          );
          if (!count) throw new Error("Trace write made no progress");
          offset += count;
        }
      },
    });
    closeSync(traceFile);
    traceFile = undefined;
    await writeFile(
      join(directory, "run.json"),
      JSON.stringify(result) + "\n",
      { flag: "wx" },
    );
    if (result.outcome === "infrastructure-failed") {
      await writeFile(
        join(directory, "failure.json"),
        JSON.stringify({
          status: "incomplete",
          message: result.message ?? "Infrastructure failure",
        }) + "\n",
        { flag: "wx" },
      );
      return result;
    }
    parseReplay(JSON.stringify(result));
    const inventory: Record<string, { bytes: number; sha256: string }> = {};
    for (const name of files) {
      const bytes = await boundedFile(join(directory, name));
      if (name === "trace.jsonl" && decode(bytes) !== result.trace)
        throw new Error("Streamed trace differs from completed result");
      inventory[name] = { bytes: bytes.length, sha256: hash(bytes) };
    }
    await writeFile(
      join(directory, "manifest.json"),
      JSON.stringify(
        {
          format: "timeline-bundle/v1",
          versions,
          source: provenance(),
          initialState: { storage: "memory", state: "empty" },
          outcome: result.outcome,
          execution: result.execution,
          environment: result.environment,
          files: inventory,
        },
        null,
        2,
      ) + "\n",
      { flag: "wx" },
    );
    return result;
  } catch (cause) {
    await writeFile(
      join(directory, "failure.json"),
      JSON.stringify({
        status: "incomplete",
        message: String(cause),
      }) + "\n",
      { flag: "wx" },
    );
    throw cause;
  } finally {
    if (traceFile !== undefined) closeSync(traceFile);
  }
}

/** All member names are fixed, bounded regular files, never manifest-supplied paths. */
export async function readBundle(directory: string) {
  if (!(await lstat(directory)).isDirectory())
    throw new Error("invalid-bundle: expected a real directory");
  const names = (await readdir(directory)).sort();
  same(names, [...files, "manifest.json"].sort(), "file inventory");
  const bytes: Record<string, Buffer> = {};
  for (const name of names) {
    const path = join(directory, name);
    if (!(await lstat(path)).isFile())
      throw new Error("invalid-bundle: expected regular member");
    bytes[name] = await boundedFile(path);
  }
  const manifest = object(
    parseJson(decode(bytes["manifest.json"])),
    "manifest",
    [
      "format",
      "versions",
      "source",
      "initialState",
      "outcome",
      "execution",
      "environment",
      "files",
    ],
  );
  if (manifest.format !== "timeline-bundle/v1")
    throw new Error("invalid-bundle: unsupported format");
  same(manifest.versions, parseJson(JSON.stringify(versions)), "versions");
  same(
    manifest.initialState,
    { storage: "memory", state: "empty" },
    "initial state",
  );
  const source = object(manifest.source, "source", [
    "revision",
    "trackedChanges",
  ]);
  if (
    (source.revision !== null &&
      !/^[0-9a-f]{40,64}$/.test(text(source.revision, "revision"))) ||
    (source.trackedChanges !== null &&
      typeof source.trackedChanges !== "boolean")
  )
    throw new Error("invalid-bundle: source provenance");
  const inventory = object(manifest.files, "files", [...files]);
  for (const name of files) {
    const entry = object(inventory[name], name, ["bytes", "sha256"]);
    if (
      integer(entry.bytes, "bytes") !== bytes[name].length ||
      entry.sha256 !== hash(bytes[name])
    )
      throw new Error(`invalid-bundle: ${name} hash/size mismatch`);
  }
  const raw = decode(bytes["run.json"]);
  const run = parseReplay(raw);
  same(manifest.outcome, run.outcome, "outcome");
  // Lossless parsed metadata is compared directly, without converting Decimal objects.
  if (
    encodeJson(manifest.execution) !== encodeJson(run.execution) ||
    encodeJson(manifest.environment) !== encodeJson(run.saved.environment)
  )
    throw new Error("invalid-bundle: execution/environment mismatch");
  if (
    decode(bytes["scenario.json"]) !== run.scenario.canonical ||
    decode(bytes["configuration.json"]) !== run.wire ||
    decode(bytes["trace.jsonl"]) !== run.saved.trace
  )
    throw new Error("invalid-bundle: retained inputs/trace mismatch");
  return raw;
}

export async function replayBundle(
  directory: string,
  options: DocumentOptions,
) {
  return replaySaved(await readBundle(directory), options);
}
