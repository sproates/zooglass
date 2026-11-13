import { actionFields } from "./event-schema.js";
import { observationList } from "./envelopes.js";
import { admitLifecycle, type AdmittedAction } from "./lifecycle.js";
import { canonicalJson, parseJson, type Json } from "./json.js";
import {
  choice,
  integer,
  invalid,
  list,
  object,
  reference,
  text,
  unique,
} from "./validation.js";

export const format = "timeline-simulation/v1";
export const capabilities = [
  "memory",
  "source-publication",
  "client-subscription",
  "client-lifecycle",
  "observations",
  "writer-stall",
] as const;
export type TimelineDocument = {
  canonical: string;
  document: { [key: string]: Json };
  requiredCapabilities: string[];
  admittedActions: AdmittedAction[];
};

/** Syntax, references and declared lifecycle admission. Does not certify runtime configuration or execution. */
export function parseTimelineDocument(raw: string): TimelineDocument {
  const canonical = canonicalJson(raw);
  const doc = object(parseJson(canonical), "$", [
    "format",
    "id",
    "clock",
    "seed",
    "runtime",
    "actors",
    "links",
    "publications",
    "actions",
    "assertions",
    "limits",
    "untilMs",
    "end",
  ]);
  choice(doc.format, "$.format", [format]);
  text(doc.id, "$.id");
  const clock = object(doc.clock, "$.clock", ["epochMillis"]);
  const epoch = integer(clock.epochMillis, "$.clock.epochMillis");
  if (!/^[a-f0-9]{64}$/.test(text(doc.seed, "$.seed")))
    invalid("$.seed", "expected lowercase 256-bit hex");
  const runtime = object(doc.runtime, "$.runtime", [
    "configuration",
    "sha256",
    "storage",
    "access",
    "initialState",
  ]);
  text(runtime.configuration, "$.runtime.configuration");
  if (!/^[a-f0-9]{64}$/.test(text(runtime.sha256, "$.runtime.sha256")))
    invalid("$.runtime.sha256", "expected lowercase SHA-256");
  choice(runtime.storage, "$.runtime.storage", ["memory"]);
  choice(runtime.access, "$.runtime.access", ["unprotected"]);
  choice(runtime.initialState, "$.runtime.initialState", ["empty"]);
  const limits = object(doc.limits, "$.limits", [
    "turns",
    "rounds",
    "queuedEvents",
    "pendingMessages",
    "traceBytes",
  ]);
  for (const [name, max] of Object.entries({
    turns: 100000,
    rounds: 1000,
    queuedEvents: 10000,
    pendingMessages: 10000,
    traceBytes: 16777216,
  }))
    integer(limits[name], `$.limits.${name}`, max, 1);
  const until = integer(doc.untilMs, "$.untilMs", 3600000);
  if (!Number.isSafeInteger(epoch + until))
    invalid("$.clock.epochMillis", "clock plus horizon overflows safe integer");
  const end = object(doc.end, "$.end", [
    "pendingFutureTasks",
    "pendingMessages",
    "heldFrames",
  ]);
  choice(end.pendingFutureTasks, "$.end.pendingFutureTasks", [
    "allow",
    "forbid",
  ]);
  integer(end.pendingMessages, "$.end.pendingMessages", 0);
  integer(end.heldFrames, "$.end.heldFrames", 0);

  const required = new Set<string>(["memory"]);
  const actors = new Set<string>();
  const sources = new Set<string>();
  const clients = new Set<string>();
  list(doc.actors, "$.actors", 100).forEach((value, i) => {
    const path = `$.actors[${i}]`;
    const actor = object(value, path, ["id", "role"]);
    const id = text(actor.id, `${path}.id`);
    unique(id, actors, `${path}.id`);
    const role = choice(actor.role, `${path}.role`, ["source", "client"]);
    (role === "source" ? sources : clients).add(id);
  });
  const linked = new Set<string>();
  list(doc.links, "$.links", 100).forEach((value, i) => {
    const path = `$.links[${i}]`;
    const link = object(value, path, ["actor", "latencyMs"]);
    const actor = reference(link.actor, actors, `${path}.actor`);
    unique(actor, linked, `${path}.actor`);
    integer(link.latencyMs, `${path}.latencyMs`, 0);
  });
  for (const actor of actors)
    if (!linked.has(actor))
      invalid(
        "$.links",
        `missing bidirectional zero-latency link for ${actor}`,
      );
  const publications = new Set<string>();
  list(doc.publications, "$.publications").forEach((value, i) => {
    const path = `$.publications[${i}]`;
    const publication = object(value, path, ["id", "body"]);
    unique(text(publication.id, `${path}.id`), publications, `${path}.id`);
    // The full publication belongs to the runtime parser, including arbitrary exact payload numbers.
    object(publication.body, `${path}.body`);
  });
  const eventIds = new Set<string>();
  const fields = actionFields;
  list(doc.actions, "$.actions").forEach((value, i) => {
    const path = `$.actions[${i}]`;
    const entry = object(value, path);
    const kind = choice(entry.kind, `${path}.kind`, Object.keys(fields));
    object(entry, path, ["id", "atMs", "kind", "actor", ...fields[kind]]);
    unique(text(entry.id, `${path}.id`), eventIds, `${path}.id`);
    integer(entry.atMs, `${path}.atMs`, until);
    reference(
      entry.actor,
      kind.startsWith("source-")
        ? sources
        : kind.startsWith("client-") || kind.startsWith("writer-")
          ? clients
          : actors,
      `${path}.actor`,
    );
    if (kind.startsWith("source-")) {
      required.add("source-publication");
      reference(entry.publication, publications, `${path}.publication`);
    } else if (kind.startsWith("client-")) {
      required.add("client-subscription");
      text(entry.viewId, `${path}.viewId`);
      text(entry.entityId, `${path}.entityId`);
    } else if (kind.startsWith("writer-")) {
      required.add("writer-stall");
      if (kind === "writer-release" && typeof entry.fail !== "boolean")
        invalid(`${path}.fail`, "expected boolean");
    } else required.add("client-lifecycle");
  });
  list(doc.assertions, "$.assertions").forEach((value, i) => {
    const path = `$.assertions[${i}]`;
    const assertion = object(value, path, [
      "id",
      "atMs",
      "kind",
      "actor",
      "expected",
    ]);
    unique(text(assertion.id, `${path}.id`), eventIds, `${path}.id`);
    integer(assertion.atMs, `${path}.atMs`, until);
    const kind = choice(assertion.kind, `${path}.kind`, [
      "client-frames",
      "source-receipts",
    ]);
    reference(
      assertion.actor,
      kind === "client-frames" ? clients : sources,
      `${path}.actor`,
    );
    observationList(assertion.expected, `${path}.expected`, kind);
    required.add("observations");
  });
  return {
    canonical,
    document: doc,
    requiredCapabilities: [...required].sort(),
    admittedActions: admitLifecycle(doc),
  };
}

/** Default deny: callers must explicitly supply capabilities after runtime/profile admission. */
export const qualifiedDocumentCapabilities: readonly string[] = [];
export function requireExecutionCapabilities(
  document: TimelineDocument,
  supported = qualifiedDocumentCapabilities,
): void {
  const missing = document.requiredCapabilities.filter(
    (item) => !supported.includes(item),
  );
  if (missing.length)
    throw new Error(
      `unsupported-execution: ${missing.join(", ")}; execution capabilities have not been admitted`,
    );
}
