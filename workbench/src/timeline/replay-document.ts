import {
  validateConversionProvenance,
  type ConversionProvenance,
} from "./conversion-provenance.js";
import { publicationIdentity } from "./projected-assertions.js";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { boundedFile, decode } from "./admission.js";
import { parseTimelineDocument, type TimelineDocument } from "./contract.js";
import { isRuntimeAction } from "./event-schema.js";
import {
  documentEvidenceVersions,
  evidenceV1,
  evidenceV2,
  evidenceV3,
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
    ...(Object.hasOwn(saved, "conversionProvenance")
      ? ["conversionProvenance"]
      : []),
    ...(Object.hasOwn(saved, "message") ? ["message"] : []),
    ...(Object.hasOwn(saved, "diagnostics") ? ["diagnostics"] : []),
  ]);
  if (saved.diagnostics !== undefined) object(saved.diagnostics, "diagnostics");
  const format = choice(saved.format, "format", [
    evidenceV1.run,
    evidenceV2.run,
    evidenceV3.run,
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
  const conversionProvenance = validateConversionProvenance(
    scenario,
    wire,
    saved.conversionProvenance as ConversionProvenance | undefined,
  );
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
  if (versions.protocol === 2) checkRuntimeDeclarations(scenario, trace);
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
    execution.configurationSha256 !== configurationHash ||
    execution.profile !== scenario.profile
  )
    throw new Error("invalid-replay: execution identity mismatch");
  const environment = object(saved.environment, "environment");
  if (
    versions.protocol === 2 &&
    environment.executor !== `${scenario.profile}/1`
  )
    throw new Error("invalid-replay: executor profile mismatch");
  if (scenario.storage === "sqlite") {
    const java = object(environment.java, "environment.java");
    text(java.sqliteVersion, "environment.java.sqliteVersion");
  }
  return {
    saved,
    scenario,
    wire,
    configurationHash,
    ...(conversionProvenance ? { conversionProvenance } : {}),
    execution,
    versions,
    lines: trace.lines,
    outcome,
  };
}

function checkRuntimeDeclarations(
  scenario: TimelineDocument,
  trace: ReturnType<typeof parseTrace>,
) {
  checkControlDeclarations(scenario, trace);
  checkProjectedDeclarations(scenario, trace);
  const actions = list(scenario.document.actions, "actions");
  const runtimeActions = scenario.admittedActions.filter((action) =>
    isRuntimeAction(action.kind),
  );
  if (
    trace.outcome === "passed" &&
    trace.runtimeActions.length !== runtimeActions.length
  )
    throw new Error("invalid-replay: missing runtime actions");
  for (const [index, { atMs, data }] of trace.runtimeActions.entries()) {
    const admitted = runtimeActions[index];
    if (
      !admitted ||
      admitted.id !== data.actionId ||
      admitted.kind !== data.actionKind ||
      admitted.atMs !== atMs
    )
      throw new Error("invalid-replay: runtime action differs from scenario");
    const declaredAction = object(actions[admitted.declaration], "action");
    if (
      data.mode !== declaredAction.mode ||
      (data.wallMillis !== undefined &&
        integer(data.wallMillis, "wallMillis") !==
          integer(declaredAction.wallMillis, "wallMillis"))
    )
      throw new Error("invalid-replay: runtime action differs from scenario");
  }

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

function checkProjectedDeclarations(
  scenario: TimelineDocument,
  trace: ReturnType<typeof parseTrace>,
) {
  if (scenario.format === evidenceV3.scenario) {
    const actions = list(scenario.document.actions, "actions").map((value) =>
      object(value, "action"),
    );
    if (
      trace.outcome === "passed" &&
      trace.staticActions.length !== actions.length
    )
      throw new Error("invalid-replay: missing static actions");
    const seen = new Set<string>();
    for (const event of trace.staticActions) {
      const id = text(event.data.actionId, "actionId");
      const declared = actions.find((action) => action.id === id);
      if (
        !declared ||
        seen.has(id) ||
        declared.actor !== event.actor ||
        integer(declared.atMs, "atMs") !== event.timeMs
      )
        throw new Error("invalid-replay: static action differs from scenario");
      seen.add(id);
      const expected: { [key: string]: Json } = {
        ...declared,
        actionId: declared.id,
        actionKind: declared.kind,
      };
      for (const key of ["id", "kind", "actor", "atMs"]) delete expected[key];
      if (encodeJson(expected) !== encodeJson(event.data))
        throw new Error(
          "invalid-replay: static action payload differs from scenario",
        );
    }
  }
  const assertions = list(scenario.document.assertions, "assertions")
    .map((value) => object(value, "assertion"))
    .filter((value) =>
      ["runtime-data", "source-accepted"].includes(String(value.kind)),
    )
    .sort((a, b) => integer(a.atMs, "atMs") - integer(b.atMs, "atMs"));
  if (
    trace.outcome === "passed" &&
    trace.projectedAssertions.length !== assertions.length
  )
    throw new Error("invalid-replay: missing projected assertions");
  for (const [index, event] of trace.projectedAssertions.entries()) {
    const declared = assertions[index];
    if (
      !declared ||
      declared.id !== event.data.assertionId ||
      declared.kind !== event.data.assertionKind ||
      integer(declared.atMs, "atMs") !== event.timeMs
    )
      throw new Error(
        "invalid-replay: projected assertion differs from scenario",
      );
    if (declared.kind === "runtime-data") {
      if (
        declared.viewId !== event.data.viewId ||
        declared.entityId !== event.data.entityId ||
        encodeJson(declared.expected) !== encodeJson(event.data.expected)
      )
        throw new Error(
          "invalid-replay: projected data expectation differs from scenario",
        );
    } else {
      const send = list(scenario.document.actions, "actions")
        .map((value) => object(value, "action"))
        .find((action) => action.id === declared.send)!;
      const publication = list(scenario.document.publications, "publications")
        .map((value) => object(value, "publication"))
        .find((value) => value.id === send.publication)!;
      if (
        declared.actor !== event.actor ||
        declared.send !== event.data.send ||
        send.publication !== event.data.publication ||
        encodeJson(publicationIdentity(publication.body)) !==
          encodeJson(event.data.identity)
      )
        throw new Error(
          "invalid-replay: acceptance identity differs from scenario",
        );
    }
  }
}

function checkControlDeclarations(
  scenario: TimelineDocument,
  trace: ReturnType<typeof parseTrace>,
) {
  const actions = list(scenario.document.actions, "actions");
  const declared = scenario.admittedActions.filter(
    (action) =>
      action.kind === "progress-send" || action.kind === "retirement-send",
  );
  if (
    trace.outcome === "passed" &&
    trace.controlActions.length !== declared.length
  )
    throw new Error(
      `invalid-replay: missing ${declared.some((action) => action.kind === "retirement-send") ? "control" : "progress"} actions`,
    );
  for (const [index, event] of trace.controlActions.entries()) {
    const expected = declared[index];
    if (
      !expected ||
      event.actor !== expected.actor ||
      event.timeMs !== expected.atMs ||
      event.data.actionId !== expected.id ||
      event.data.actionKind !== expected.kind ||
      encodeJson(event.data.control) !==
        encodeJson(object(actions[expected.declaration], "action").control)
    )
      throw new Error(
        `invalid-replay: ${event.data.actionKind === "retirement-send" || expected?.kind === "retirement-send" ? "retirement" : "progress"} action differs from scenario`,
      );
  }
  const assertions = list(scenario.document.assertions, "assertions")
    .map((value) => object(value, "assertion"))
    .filter((value) => value.kind === "control-receipts")
    .sort((a, b) => integer(a.atMs, "atMs") - integer(b.atMs, "atMs"));
  if (
    trace.outcome === "passed" &&
    trace.controlAssertions.length !== assertions.length
  )
    throw new Error("invalid-replay: missing control receipt assertions");
  for (const [index, event] of trace.controlAssertions.entries()) {
    const expected = assertions[index];
    if (
      !expected ||
      event.actor !== expected.actor ||
      event.timeMs !== integer(expected.atMs, "atMs") ||
      event.data.assertionId !== expected.id ||
      encodeJson(event.data.expected) !== encodeJson(expected.expected)
    )
      throw new Error(
        "invalid-replay: control receipt assertion differs from scenario",
      );
  }
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
