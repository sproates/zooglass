import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { buffer } from "node:stream/consumers";
import { fromBufferPromise } from "yauzl";
import {
  boundedFile,
  decode,
  loadDocument,
} from "../src/timeline/admission.js";
import type { DocumentRun } from "../src/timeline/campaign-checks.js";
import { parseTimelineDocument } from "../src/timeline/contract.js";
import { parseReplay } from "../src/timeline/replay-document.js";

const digest = (value: Buffer | string) =>
  createHash("sha256").update(value).digest("hex");

export async function captureControlInput(path: string) {
  const bytes = await boundedFile(path);
  const input = await loadDocument(path);
  assert.equal(
    parseTimelineDocument(decode(bytes)).canonical,
    input.scenario.canonical,
    "scenario changed while capturing control input",
  );
  return {
    input,
    identities: {
      scenarioSourceSha256: digest(bytes),
      scenarioSha256: digest(input.scenario.canonical),
      configurationSha256: input.configurationHash,
    },
  };
}

export async function jarInventory(jar: Buffer) {
  const archive = await fromBufferPromise(jar, { decodeStrings: false });
  const entries = new Map<string, string>();
  const names = new Set<string>();
  let totalBytes = 0;
  try {
    assert.ok(archive.entryCount <= 4096, "oversized prepared JAR directory");
    for await (const entry of archive.eachEntry()) {
      const name = entry.fileNameRaw.toString("latin1");
      assert.ok(!names.has(name), `duplicate prepared host entry: ${name}`);
      names.add(name);
      if (name.endsWith("/")) continue;
      totalBytes += entry.uncompressedSize;
      assert.ok(
        entry.uncompressedSize <= 32 * 1024 * 1024 &&
          totalBytes <= 80 * 1024 * 1024,
        `oversized prepared JAR entry: ${name}`,
      );
      const bytes = await buffer(await archive.openReadStreamPromise(entry));
      assert.equal(
        bytes.length,
        entry.uncompressedSize,
        `prepared JAR entry size: ${name}`,
      );
      entries.set(name, digest(bytes));
    }
    return entries;
  } finally {
    archive.close();
  }
}

/** Read an entry only after validating the complete bounded archive inventory. */
export async function jarEntry(jar: Buffer, name: string) {
  const inventory = await jarInventory(jar);
  assert.ok(inventory.has(name), `missing prepared JAR entry: ${name}`);
  const archive = await fromBufferPromise(jar, { decodeStrings: false });
  try {
    for await (const entry of archive.eachEntry()) {
      if (entry.fileNameRaw.toString("latin1") === name)
        return await buffer(await archive.openReadStreamPromise(entry));
    }
    throw new Error(`missing prepared JAR entry: ${name}`);
  } finally {
    archive.close();
  }
}

export async function readJar(path: string) {
  const file = await open(path, "r");
  try {
    const stat = await file.stat();
    assert.ok(
      stat.isFile() && stat.size <= 64 * 1024 * 1024,
      "prepared artifact size outside limits",
    );
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      assert.ok(bytesRead, "prepared artifact ended unexpectedly");
      offset += bytesRead;
    }
    assert.equal(
      (await file.stat()).size,
      stat.size,
      "prepared artifact size changed",
    );
    return bytes;
  } finally {
    await file.close();
  }
}

export function comparableRuns(
  normal: DocumentRun,
  mutant: DocumentRun,
  paused: DocumentRun,
  expectedFailure: string,
) {
  assert.equal(
    normal.outcome,
    "passed",
    normal.message ?? "normal run must pass",
  );
  for (const run of [mutant, paused]) {
    assert.equal(
      run.outcome,
      "assertion-failed",
      "mutant must fail semantically after executing the scenario",
    );
    assert.equal(run.message, `assertion-failed: ${expectedFailure}`);
    assert.equal(run.scenario, normal.scenario);
    assert.equal(run.configuration, normal.configuration);
    assert.deepEqual(run.environment, normal.environment);
    assert.deepEqual(run.execution, {
      ...normal.execution,
      artifactSha256: mutant.execution.artifactSha256,
    });
  }
  assert.notEqual(
    normal.execution.artifactSha256,
    mutant.execution.artifactSha256,
  );
  assert.equal(
    mutant.trace,
    paused.trace,
    "host pauses must leave the mutant's wrong semantic trace identical",
  );

  const normalLines = parseReplay(JSON.stringify(normal)).lines;
  const mutantLines = parseReplay(JSON.stringify(mutant)).lines;
  const good = normalLines.map((line) => JSON.parse(line));
  const bad = mutantLines.map((line) => JSON.parse(line));
  const mismatchIndex = normalLines.findIndex(
    (line, index) => index > 0 && line !== mutantLines[index],
  );
  return { good, bad, mismatchIndex };
}
