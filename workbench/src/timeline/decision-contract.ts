import { encodeJson, type Json } from "./json.js";
import {
  choice,
  invalid,
  list,
  object,
  runtimeCounter,
  text,
  unique,
} from "./validation.js";

const strategies = {
  arrival: ["ARRIVAL_REPLACED"],
  latestBySequence: [
    "SEQUENCE_MISSING",
    "LATEST_INITIAL",
    "LATEST_NEWER",
    "LATEST_EQUAL",
    "LATEST_OLDER",
  ],
  historyBySequence: [
    "SEQUENCE_MISSING",
    "HISTORY_INSERTED",
    "HISTORY_EXISTING",
  ],
} as const;
const changed = new Set([
  "ARRIVAL_REPLACED",
  "LATEST_INITIAL",
  "LATEST_NEWER",
  "HISTORY_INSERTED",
]);

/** Closed production sidecar. Reasons are checked, never reconstructed from values. */
export function decisionEnvelope(value: Json | undefined, path: string) {
  const envelope = object(value, path);
  const availability = choice(envelope.availability, path, [
    "recorded",
    "unavailable",
  ]);
  if (availability === "unavailable") {
    object(envelope, path, ["availability", "reason"]);
    choice(envelope.reason, path, ["processingFailure", "invalidEnvelope"]);
    return envelope;
  }
  object(envelope, path, ["availability", "decision"]);
  const decision = object(envelope.decision, path, [
    "format",
    "stream",
    "publicationSequence",
    "status",
    "reason",
    "version",
    "installed",
    "targets",
  ]);
  choice(decision.format, path, ["publication-decision/v1"]);
  const stream = object(decision.stream, path, [
    "sourceId",
    "epoch",
    "sourceEntityId",
  ]);
  for (const field of Object.keys(stream))
    text(stream[field], `${path}.stream.${field}`);
  runtimeCounter(decision.publicationSequence, path);
  runtimeCounter(decision.version, path, true);
  const status = choice(decision.status, path, [
    "applied",
    "committed",
    "duplicate",
    "rejected",
  ]);
  if (decision.reason !== null) text(decision.reason, path);
  if (decision.installed !== (status === "applied" || status === "committed"))
    invalid(path, "installation disagrees with processing status");
  const targets = list(decision.targets, path, 2);
  if (!decision.installed && targets.length)
    invalid(path, "uninstalled attempt cannot contain target changes");
  const seen = new Set<string>();
  for (const value of targets) {
    const target = object(value, path, ["viewId", "entityId", "fields"]);
    text(target.viewId, path);
    if (target.entityId !== null) text(target.entityId, path);
    unique(encodeJson([target.viewId, target.entityId]), seen, path);
    const fields = new Set<string>();
    for (const value of list(target.fields, path, 4)) {
      const field = object(value, path, [
        "field",
        "strategy",
        "update",
        "retainedChanged",
        "publicChanged",
      ]);
      unique(text(field.field, path), fields, path);
      const strategy = choice(
        field.strategy,
        path,
        Object.keys(strategies),
      ) as keyof typeof strategies;
      const update = choice(field.update, path, strategies[strategy]);
      if (
        typeof field.publicChanged !== "boolean" ||
        field.retainedChanged !== changed.has(update) ||
        (!field.retainedChanged && field.publicChanged)
      )
        invalid(path, "field change flags disagree with update reason");
    }
  }
  return envelope;
}
