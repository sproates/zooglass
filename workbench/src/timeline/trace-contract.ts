import { eventData, lifecycleEventKinds } from "./event-schema.js";
import { evidenceV1, evidenceV2 } from "./evidence-versions.js";
import { TraceGenerations } from "./trace-generations.js";
import { encodeJson, jsonLimits, parseJson } from "./json.js";
import {
  choice,
  integer,
  invalid,
  list,
  object,
  text,
  unique,
} from "./validation.js";

const eventKinds = [
  "action",
  "fault-decision",
  "link-send",
  "retry-status",
  "retry-lifecycle",
  "retry-attempt",
  "runtime-command",
  "task-dispatched",
  "connection-closed",
  "handoff",
  "scheduled",
  "cancelled",
  "delivered",
  "dropped",
  "receipt",
  "state",
  "frame",
  "assertion",
];

/** Parse complete semantic JSONL artifacts and retain the canonical lines used for replay. */
export function parseTrace(raw: string) {
  if (Buffer.byteLength(raw) > jsonLimits.bytes)
    throw new Error("invalid-trace: byte limit");
  const lines = raw.trimEnd().split("\n");
  if (lines.length < 2 || lines.length > 100001)
    throw new Error("invalid-trace: record count");
  const canonical: string[] = [];
  const ids = new Set<string>();
  let previous = [0, 0, 0, -1];
  let failedAssertion = false;
  let remainingBytes = jsonLimits.bytes;
  const readRecord = (index: number) => {
    // Include every terminating newline and stop expansion at the artifact's remaining budget.
    if (remainingBytes === 0)
      throw new Error("invalid-trace: canonical byte limit");
    const record = object(
      parseJson(lines[index], remainingBytes - 1),
      `trace[${index}]`,
    );
    const encoded = encodeJson(record) + "\n";
    remainingBytes -= Buffer.byteLength(encoded);
    canonical.push(encoded);
    return record;
  };
  const header = traceHeader(readRecord(0));
  const until = header.untilMs;
  const version = header.format === evidenceV2.trace ? 2 : 1;
  const kinds =
    version === 2 ? [...eventKinds, ...lifecycleEventKinds] : eventKinds;
  const generations = version === 2 ? new TraceGenerations() : undefined;
  for (let index = 1; index < lines.length - 1; index++) {
    const record = readRecord(index);
    const path = `trace[${index}]`;
    object(record, path, [
      "kind",
      "eventId",
      "parentId",
      "key",
      "actor",
      "runtimeGeneration",
      "connectionGeneration",
      "data",
      ...(Object.hasOwn(record, "causes") ? ["causes"] : []),
    ]);
    const causes =
      record.causes === undefined
        ? []
        : list(record.causes, `${path}.causes`, 1000).map((cause) => {
            const id = text(cause, `${path}.causes`);
            if (!ids.has(id))
              invalid(path, "cause must identify an earlier event");
            return id;
          });
    const kind = choice(record.kind, `${path}.kind`, kinds);
    const parent =
      record.parentId === null
        ? null
        : text(record.parentId, `${path}.parentId`);
    if (parent !== null && !ids.has(parent))
      invalid(path, "parent must identify an earlier event");
    const id = text(record.eventId, `${path}.eventId`);
    unique(id, ids, `${path}.eventId`);
    const coordinates = list(record.key, `${path}.key`, 4);
    if (coordinates.length !== 4)
      invalid(path, "agenda key must have four coordinates");
    const key = coordinates.map((value, i) =>
      integer(
        value,
        `${path}.key[${i}]`,
        [until, 1000, 2, Number.MAX_SAFE_INTEGER][i],
      ),
    );
    if (key.reduce((order, item, i) => order || item - previous[i], 0) < 0)
      invalid(path, "agenda keys must not decrease");
    previous = key;
    const actor = text(record.actor, `${path}.actor`);
    const runtimeGeneration =
      version === 2 && record.runtimeGeneration === null
        ? null
        : integer(
            record.runtimeGeneration,
            `${path}.runtimeGeneration`,
            version === 1 ? Number.MAX_SAFE_INTEGER : 16,
            1,
          );
    const connectionGeneration =
      record.connectionGeneration === null
        ? null
        : integer(
            record.connectionGeneration,
            `${path}.connectionGeneration`,
            Number.MAX_SAFE_INTEGER,
            1,
          );
    eventData(kind, record.data, `${path}.data`, key[0], until, version);
    generations?.accept(
      {
        kind,
        id,
        parent,
        causes,
        actor,
        timeMs: key[0],
        runtimeGeneration,
        connectionGeneration,
        data: object(record.data, `${path}.data`),
      },
      path,
    );
    if (
      kind === "assertion" &&
      object(record.data, `${path}.data`).passed === false
    )
      failedAssertion = true;
  }
  const last = lines.length - 1;
  const outcome = traceOutcome(
    readRecord(last),
    `trace[${last}]`,
    ids.size,
    failedAssertion,
  );
  const epochMillis = generations?.finish(outcome);
  return {
    canonical: canonical.join(""),
    lines: canonical,
    header,
    outcome,
    epochMillis,
  };
}

function traceHeader(value: ReturnType<typeof object>) {
  const path = "trace[0]";
  const record = object(value, path, [
    "format",
    "scenarioSha256",
    "untilMs",
    ...(Object.hasOwn(value, "execution") ? ["execution"] : []),
  ]);
  const format = choice(record.format, `${path}.format`, [
    evidenceV1.trace,
    evidenceV2.trace,
  ]);
  const versions = format === evidenceV2.trace ? evidenceV2 : evidenceV1;
  let execution;
  if (versions === evidenceV2 && record.execution === undefined)
    invalid(`${path}.execution`, "required for lifecycle evidence");
  if (record.execution !== undefined) {
    execution = object(record.execution, `${path}.execution`, [
      "profile",
      "artifactSha256",
      "configurationSha256",
      "workbenchSha256",
    ]);
    choice(execution.profile, `${path}.execution.profile`, [versions.profile]);
    for (const name of [
      "artifactSha256",
      "configurationSha256",
      "workbenchSha256",
    ])
      if (
        !/^[a-f0-9]{64}$/.test(
          text(execution[name], `${path}.execution.${name}`),
        )
      )
        invalid(path, "expected execution SHA-256");
  }
  const scenarioSha256 = text(record.scenarioSha256, `${path}.scenarioSha256`);
  if (!/^[a-f0-9]{64}$/.test(scenarioSha256))
    invalid(path, "expected scenario SHA-256");
  return {
    format: versions.trace,
    scenarioSha256,
    untilMs: integer(record.untilMs, `${path}.untilMs`, 3600000),
    execution,
  };
}

function traceOutcome(
  value: ReturnType<typeof object>,
  path: string,
  eventCount: number,
  failedAssertion: boolean,
) {
  const record = object(value, path, [
    "kind",
    "outcome",
    "eventCount",
    "pendingFutureTasks",
    "pendingMessages",
    "heldFrames",
  ]);
  choice(record.kind, `${path}.kind`, ["result"]);
  const outcome = choice(record.outcome, `${path}.outcome`, [
    "passed",
    "assertion-failed",
    "limit-exceeded",
    "infrastructure-failed",
  ]);
  if (integer(record.eventCount, `${path}.eventCount`) !== eventCount)
    invalid(path, "event count mismatch");
  integer(record.pendingFutureTasks, `${path}.pendingFutureTasks`);
  const pendingMessages = integer(
    record.pendingMessages,
    `${path}.pendingMessages`,
  );
  const heldFrames = integer(record.heldFrames, `${path}.heldFrames`);
  if (outcome === "passed" && failedAssertion)
    invalid(path, "passing result cannot contain a failed assertion");
  if (outcome === "passed" && (pendingMessages || heldFrames))
    invalid(path, "passing result cannot retain messages or held frames");
  return outcome;
}

export function validateTrace(raw: string): string {
  return parseTrace(raw).canonical;
}
