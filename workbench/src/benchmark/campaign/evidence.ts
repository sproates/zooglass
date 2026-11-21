import { createReadStream } from "node:fs";
import { open, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { Workload } from "../workload.js";
import type { Observation } from "../model.js";
import { classify, measure, type DriverReport } from "../metrics.js";
import {
  startupOutcome,
  type StartupFailure,
  type VerifyResult,
} from "./model.js";

export async function json(path: string): Promise<unknown> {
  if ((await stat(path)).size > 16 * 1024 * 1024)
    throw new Error("Campaign JSON exceeds bound");
  return JSON.parse(await readFile(path, "utf8"));
}
export async function writeJson(path: string, value: unknown) {
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
}
export async function writeObservations(
  path: string,
  chunks: Iterable<Buffer>,
  checkpoint: () => Promise<void> = async () => {},
) {
  const file = await open(path, "wx");
  try {
    for (const chunk of chunks) {
      await checkpoint();
      await file.writeFile(chunk);
    }
    await checkpoint();
  } finally {
    await file.close();
  }
}
export async function* observations(
  path: string,
  checkpoint: () => Promise<void> = async () => {},
) {
  const stream = createReadStream(path);
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let count = 0;
  try {
    for await (const line of lines) {
      if (++count > 2_000_000 || line.length > 4096)
        throw new Error("Observation bound exceeded");
      if (count % 4096 === 0) await checkpoint();
      yield JSON.parse(line) as Observation;
    }
  } finally {
    lines.close();
    stream.destroy();
  }
}
export async function artifactNames(directory: string) {
  return (await readdir(directory))
    .filter((name) => name !== "input.json")
    .sort();
}

export const verifyResult: VerifyResult = async (
  token,
  completion,
  checkpoint,
) => {
  const names = completion.artifacts.map((a) => a.name).sort();
  const store = names.filter((name) =>
    /^store\.sqlite(?:-wal|-shm|-journal)?$/.test(name),
  );
  if (token.slot.storage === "memory" && store.length)
    throw new Error("Memory attempt has a store");
  const actual = names.filter((name) => !store.includes(name));
  if (isDeepStrictEqual(actual, ["failure.json"])) {
    const failure = (await json(
      join(token.directory, "failure.json"),
    )) as StartupFailure;
    if (
      failure.status !== "failed-before-result" ||
      !failure.error ||
      completion.outcome !== startupOutcome(failure) ||
      completion.reason !== failure.error
    )
      throw new Error("Invalid startup failure evidence");
    return;
  }
  if (
    !isDeepStrictEqual(actual, [
      "metrics.json",
      "observations.jsonl",
      "resources.json",
      "run.json",
    ])
  )
    throw new Error("Unexpected result files");
  const report = (await json(
    join(token.directory, "run.json"),
  )) as DriverReport;
  if (
    report.format !== "benchmark-driver/v1" ||
    !isDeepStrictEqual(
      report.configuration,
      new Workload(token.slot.workload).configuration,
    ) ||
    !isDeepStrictEqual(report.options.workload, token.slot.workload) ||
    report.options.rate !== token.rate ||
    report.options.warmupMs !== 30000 ||
    report.options.measurementMs !== 120000 ||
    report.options.drainMs !== 10000
  )
    throw new Error("Result inputs differ from reserved attempt");
  const metrics = await measure(
    report,
    observations(join(token.directory, "observations.jsonl"), checkpoint),
  );
  const resources = (await json(join(token.directory, "resources.json"))) as {
    clientDiagnostic?: {
      qualified?: boolean;
      submitted?: number;
      missed?: number;
    };
  };
  const diagnostic = resources.clientDiagnostic;
  if (!isDeepStrictEqual(diagnostic, token.clientDiagnostic))
    throw new Error("Client diagnostic differs from its session");
  if (
    !diagnostic ||
    typeof diagnostic.qualified !== "boolean" ||
    diagnostic.qualified !==
      (diagnostic.submitted === 1000 && diagnostic.missed === 0)
  )
    throw new Error("Invalid client diagnostic evidence");
  const expected = classify(report, metrics, diagnostic.qualified);
  const saved = await json(join(token.directory, "metrics.json"));
  if (
    !isDeepStrictEqual(saved, { ...metrics, classification: expected }) ||
    completion.outcome !== expected.outcome ||
    completion.reason !== expected.reasons.join("; ")
  )
    throw new Error("Result metrics or outcome do not reproduce");
  const raw = completion.artifacts.find(
    (a) => a.name === "observations.jsonl",
  )!;
  if (raw.bytes !== report.accounting.encodedBytes)
    throw new Error("Raw byte accounting differs");
  await checkpoint();
};
