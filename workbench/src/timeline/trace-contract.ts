import { eventData } from "./event-schema.js";
import { canonicalJson, jsonLimits, parseJson } from "./json.js";
import {
  choice,
  integer,
  invalid,
  list,
  object,
  text,
  unique,
} from "./validation.js";

/** Validate complete semantic JSONL artifacts. Private fixed-proof transcripts are a different format. */
export function validateTrace(raw: string): string {
  if (Buffer.byteLength(raw) > jsonLimits.bytes)
    throw new Error("invalid-trace: byte limit");
  const lines = raw.trimEnd().split("\n");
  if (lines.length < 2 || lines.length > 100001)
    throw new Error("invalid-trace: record count");
  const canonical: string[] = [];
  const ids = new Set<string>();
  let previous = [0, 0, 0, -1];
  let until = 0;
  let failedAssertion = false;
  let remainingBytes = jsonLimits.bytes;
  for (const [index, line] of lines.entries()) {
    // Include every terminating newline and stop expansion at the artifact's remaining budget.
    if (remainingBytes === 0)
      throw new Error("invalid-trace: canonical byte limit");
    const encoded = canonicalJson(line, remainingBytes - 1);
    remainingBytes -= Buffer.byteLength(encoded) + 1;
    const record = object(parseJson(encoded), `trace[${index}]`);
    const path = `trace[${index}]`;
    if (index === 0) {
      object(record, path, ["format", "scenarioSha256", "untilMs"]);
      choice(record.format, `${path}.format`, ["timeline-trace/v1"]);
      if (
        !/^[a-f0-9]{64}$/.test(
          text(record.scenarioSha256, `${path}.scenarioSha256`),
        )
      )
        invalid(path, "expected scenario SHA-256");
      until = integer(record.untilMs, `${path}.untilMs`, 3600000);
    } else if (index === lines.length - 1) {
      object(record, path, [
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
      if (integer(record.eventCount, `${path}.eventCount`) !== ids.size)
        invalid(path, "event count mismatch");
      integer(record.pendingFutureTasks, `${path}.pendingFutureTasks`);
      integer(record.pendingMessages, `${path}.pendingMessages`);
      integer(record.heldFrames, `${path}.heldFrames`);
      if (outcome === "passed" && failedAssertion)
        invalid(path, "passing result cannot contain a failed assertion");
      if (
        outcome === "passed" &&
        (integer(record.pendingMessages, path) ||
          integer(record.heldFrames, path))
      )
        invalid(path, "passing result cannot retain messages or held frames");
    } else {
      object(record, path, [
        "kind",
        "eventId",
        "parentId",
        "key",
        "actor",
        "runtimeGeneration",
        "connectionGeneration",
        "data",
      ]);
      const kind = choice(record.kind, `${path}.kind`, [
        "action",
        "scheduled",
        "cancelled",
        "delivered",
        "dropped",
        "receipt",
        "state",
        "frame",
        "assertion",
      ]);
      if (
        record.parentId !== null &&
        !ids.has(text(record.parentId, `${path}.parentId`))
      )
        invalid(path, "parent must identify an earlier event");
      unique(text(record.eventId, `${path}.eventId`), ids, `${path}.eventId`);
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
      text(record.actor, `${path}.actor`);
      integer(
        record.runtimeGeneration,
        `${path}.runtimeGeneration`,
        Number.MAX_SAFE_INTEGER,
        1,
      );
      if (record.connectionGeneration !== null)
        integer(
          record.connectionGeneration,
          `${path}.connectionGeneration`,
          Number.MAX_SAFE_INTEGER,
          1,
        );
      eventData(kind, record.data, `${path}.data`, key[0], until);
      if (
        kind === "assertion" &&
        object(record.data, `${path}.data`).passed === false
      )
        failedAssertion = true;
    }
    canonical.push(encoded);
  }
  return canonical.join("\n") + "\n";
}
