import { retryPolicies } from "./retry-policy.js";
import type { TimelineDocument } from "./contract.js";
import { encodeJson } from "./json.js";
import { integer, list, object, text } from "./validation.js";

export const documentProfile = "memory-arrival-v1";
export function executionSettings(
  scenario: TimelineDocument,
  configuration: string,
) {
  const doc = scenario.document;
  const limits = object(doc.limits, "$.limits");
  const settings = {
    turns: integer(limits.turns, "$.limits.turns", 2000, 1),
    rounds: integer(limits.rounds, "$.limits.rounds", 100, 1),
    queuedEvents: integer(
      limits.queuedEvents,
      "$.limits.queuedEvents",
      1000,
      1,
    ),
    pendingMessages: integer(
      limits.pendingMessages,
      "$.limits.pendingMessages",
      1000,
      1,
    ),
    traceBytes: integer(
      limits.traceBytes,
      "$.limits.traceBytes",
      16777216,
      1024,
    ),
  };
  list(doc.actors, "$.actors", 10).forEach((actor) => {
    if (text(object(actor, "actor").id, "actor.id").startsWith("@"))
      throw new Error(
        "unsupported-execution: actor IDs starting with @ are reserved",
      );
  });
  const actions = list(doc.actions, "$.actions");
  if (
    actions.filter((entry) => object(entry, "action").kind === "connect")
      .length +
      retryPolicies(doc).reduce(
        (total, policy) => total + policy.maxAttempts - 1,
        0,
      ) >
    10
  )
    throw new Error(
      "unsupported-execution: at most ten connection generations per document",
    );
  for (const publication of list(doc.publications, "$.publications")) {
    if (
      Buffer.byteLength(encodeJson(object(publication, "publication").body)) >
      4096
    )
      throw new Error(
        "unsupported-execution: publication body exceeds 4096 canonical bytes",
      );
  }
  if (Buffer.byteLength(configuration) > 65536)
    throw new Error("unsupported-execution: configuration exceeds 65536 bytes");
  return settings;
}
