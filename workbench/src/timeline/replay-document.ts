import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { boundedFile, decode } from "./admission.js";
import { parseTimelineDocument } from "./contract.js";
import {
  documentEvidenceVersions,
  evidenceV1,
  evidenceV2,
} from "./evidence-versions.js";
import { encodeJson, parseJson, type Json } from "./json.js";
import { workbenchIdentity } from "./manifest.js";
import { executeDocument, type DocumentOptions } from "./run-document.js";
import { parseTrace } from "./trace-contract.js";
import { choice, integer, list, object, text } from "./validation.js";

const sha = (text: string | Buffer) =>
  createHash("sha256").update(text).digest("hex");
const string = (value: Json, name: string) => {
  if (typeof value !== "string")
    throw new Error(`invalid-replay: ${name} must be a string`);
  return value;
};
const same = (a: unknown, b: Json, label: string) => {
  if (encodeJson(parseJson(JSON.stringify(a))) !== encodeJson(b))
    throw new Error(`invalid-replay: ${label} mismatch`);
};

/** Validate the complete saved evidence before launching Java. Hashes are consistency, not signatures. */
export function parseReplay(raw: string) {
  const saved = object(parseJson(raw), "run");
  object(saved, "run", [
    "format",
    "environment",
    "outcome",
    "scenario",
    "configuration",
    "execution",
    "trace",
    ...(Object.hasOwn(saved, "message") ? ["message"] : []),
    ...(Object.hasOwn(saved, "diagnostics") ? ["diagnostics"] : []),
  ]);
  if (saved.diagnostics !== undefined) object(saved.diagnostics, "diagnostics");
  const format = choice(saved.format, "format", [
    evidenceV1.run,
    evidenceV2.run,
  ]);
  const outcome = choice(saved.outcome, "outcome", [
    "passed",
    "assertion-failed",
    "limit-exceeded",
  ]);
  if (saved.message !== undefined) string(saved.message, "message");
  const scenario = parseTimelineDocument(string(saved.scenario, "scenario"));
  const versions = documentEvidenceVersions(scenario.document.format);
  if (format !== versions.run)
    throw new Error("invalid-replay: run/scenario version mismatch");
  if (scenario.canonical !== saved.scenario)
    throw new Error("invalid-replay: noncanonical scenario");
  const wire = string(saved.configuration, "configuration");
  const configurationHash = sha(wire);
  if (object(scenario.document.runtime, "runtime").sha256 !== configurationHash)
    throw new Error("invalid-replay: configuration hash mismatch");
  const trace = parseTrace(
    string(saved.trace, "trace"),
    scenario.observationTargets,
    scenario.storage,
  );
  if (trace.header.format !== versions.trace)
    throw new Error("invalid-replay: run/trace version mismatch");
  if (trace.canonical !== saved.trace)
    throw new Error("invalid-replay: noncanonical trace");
  if (versions.protocol === 2) {
    const declared = list(scenario.document.assertions, "assertions")
      .map((value) => object(value, "assertion"))
      .filter((assertion) => assertion.kind === "runtime-snapshot")
      .map((assertion) => ({
        assertion,
        atMs: integer(assertion.atMs, "assertion.atMs"),
      }))
      .sort((a, b) => a.atMs - b.atMs);
    if (
      trace.outcome === "passed" &&
      trace.runtimeAssertions.length !== declared.length
    )
      throw new Error("invalid-replay: missing runtime snapshot assertions");
    for (const [index, { atMs, data }] of trace.runtimeAssertions.entries()) {
      const expected = declared[index];
      if (
        !expected ||
        atMs !== expected.atMs ||
        data.assertionId !== expected.assertion.id ||
        data.viewId !== expected.assertion.viewId ||
        data.entityId !== expected.assertion.entityId ||
        encodeJson(data.expected) !== encodeJson(expected.assertion.expected)
      )
        throw new Error(
          "invalid-replay: runtime snapshot assertion differs from scenario",
        );
    }
  }
  if (
    trace.header.scenarioSha256 !== sha(scenario.canonical) ||
    trace.header.untilMs !== integer(scenario.document.untilMs, "untilMs") ||
    (trace.epochMillis !== undefined &&
      trace.epochMillis !==
        integer(
          object(scenario.document.clock, "clock").epochMillis,
          "epochMillis",
        )) ||
    trace.outcome !== outcome
  )
    throw new Error("invalid-replay: scenario/result identity mismatch");
  const execution = object(saved.execution, "execution");
  if (
    !trace.header.execution ||
    encodeJson(trace.header.execution) !== encodeJson(execution) ||
    execution.configurationSha256 !== configurationHash
  )
    throw new Error("invalid-replay: execution identity mismatch");
  const environment = object(saved.environment, "environment");
  if (scenario.storage === "sqlite") {
    const java = object(environment.java, "environment.java");
    text(java.sqliteVersion, "environment.java.sqliteVersion");
  }
  return {
    saved,
    scenario,
    wire,
    configurationHash,
    execution,
    versions,
    lines: trace.lines,
    outcome,
  };
}

export type Divergence = {
  record: number;
  expected: string | null;
  actual: string | null;
};
export class ReplayComparison {
  matched = 0;
  divergence?: Divergence;
  constructor(private readonly expected: string[]) {}
  observe = (actual: string) => {
    if (this.expected[this.matched] !== actual) {
      this.divergence = {
        record: this.matched,
        expected: this.expected[this.matched] ?? null,
        actual,
      };
      throw new Error(`replay-diverged: record ${this.matched}`);
    }
    this.matched++;
  };
  finish() {
    if (!this.divergence && this.matched !== this.expected.length)
      this.divergence = {
        record: this.matched,
        expected: this.expected[this.matched],
        actual: null,
      };
  }
}

export async function replayDocument(path: string, options: DocumentOptions) {
  const input = parseReplay(decode(await boundedFile(path)));
  return replaySaved(input, options);
}

export async function replaySaved(
  input: ReturnType<typeof parseReplay>,
  options: DocumentOptions,
) {
  if (
    text(input.execution.artifactSha256, "artifactSha256") !==
    sha(await readFile(options.jar))
  )
    throw new Error("invalid-replay: prepared artifact mismatch");
  if (input.execution.workbenchSha256 !== (await workbenchIdentity()))
    throw new Error("invalid-replay: Workbench identity mismatch");
  const comparison = new ReplayComparison(input.lines);
  const actual = await executeDocument(input, {
    ...options,
    admitReplay: (identity, environment) => {
      same(identity, input.execution, "execution identity");
      same(environment, input.saved.environment, "environment");
    },
    observeRecord: comparison.observe,
  });
  if (!comparison.divergence && actual.outcome === "infrastructure-failed")
    return {
      status: "infrastructure-failed",
      recordedOutcome: input.outcome,
      matchedRecords: comparison.matched,
      actual,
    };
  comparison.finish();
  return {
    status: comparison.divergence ? "diverged" : "verified",
    recordedOutcome: input.outcome,
    matchedRecords: comparison.matched,
    ...(comparison.divergence ? { divergence: comparison.divergence } : {}),
    actual,
  };
}
