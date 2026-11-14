import { retryPolicies, type RetryPolicy } from "./retry-policy.js";
import { receiptRules } from "./receipt-faults.js";
import {
  actionFields,
  isRuntimeAction,
  runtimeActionFields,
  stopModes,
  type ActorActionKind,
} from "./event-schema.js";
import {
  observationList,
  observationTarget,
  runtimeObservation,
  type ObservationTarget,
} from "./envelopes.js";
import {
  documentEvidenceVersions,
  fleetProfile,
  evidenceV1,
  evidenceV2,
} from "./evidence-versions.js";
import { admitLifecycle, type AdmittedAction } from "./lifecycle.js";
import { encodeJson, parseJson, type Json } from "./json.js";
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

export const format = evidenceV1.scenario;
export const lifecycleFormat = evidenceV2.scenario;
export const capabilities = [
  "memory",
  "source-publication",
  "client-subscription",
  "client-lifecycle",
  "observations",
  "writer-stall",
  "receipt-loss",
  "automatic-retry",
  "link-latency",
] as const;
export const lifecycleCapabilities = [
  ...capabilities,
  "memory-lifecycle",
  "runtime-observations",
  "wall-clock-adjustments",
] as const;
export const sqliteLifecycleCapabilities = [
  ...lifecycleCapabilities,
  "sqlite",
] as const;
export type TimelineDocument = {
  format: typeof format | typeof lifecycleFormat;
  storage: "memory" | "sqlite";
  profile: string;
  observationTargets: ObservationTarget[];
  canonical: string;
  document: { [key: string]: Json };
  requiredCapabilities: string[];
  admittedActions: AdmittedAction[];
  retryPolicies: RetryPolicy[];
};

/** Syntax, references and declared lifecycle admission. Does not certify runtime configuration or execution. */
export function parseTimelineDocument(raw: string): TimelineDocument {
  const rawDocument = object(parseJson(raw), "$");
  const versions = documentEvidenceVersions(rawDocument.format);
  const lifecycle = versions.protocol === 2;
  const doc = object(rawDocument, "$", [
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
    ...(Object.hasOwn(rawDocument, "faults") ? ["faults"] : []),
    ...(Object.hasOwn(rawDocument, "retries") ? ["retries"] : []),
    ...(lifecycle && Object.hasOwn(rawDocument, "observationTargets")
      ? ["observationTargets"]
      : []),
  ]);
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
    ...(lifecycle && Object.hasOwn(object(doc.runtime, "$.runtime"), "profile")
      ? ["profile"]
      : []),
  ]);
  text(runtime.configuration, "$.runtime.configuration");
  if (!/^[a-f0-9]{64}$/.test(text(runtime.sha256, "$.runtime.sha256")))
    invalid("$.runtime.sha256", "expected lowercase SHA-256");
  const storage = choice(
    runtime.storage,
    "$.runtime.storage",
    lifecycle ? ["memory", "sqlite"] : ["memory"],
  ) as TimelineDocument["storage"];
  const profile =
    runtime.profile === undefined
      ? versions.profile
      : choice(runtime.profile, "$.runtime.profile", [fleetProfile]);
  if (profile === fleetProfile && storage !== "memory")
    invalid(
      "$.runtime.storage",
      "memory sequence fleet requires memory storage",
    );
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

  const required = new Set<string>([storage]);
  if (lifecycle) required.add("memory-lifecycle");
  const targets = new Set<string>();
  const observationTargets =
    doc.observationTargets === undefined
      ? []
      : list(doc.observationTargets, "$.observationTargets", 64).map(
          (value, index) => {
            const path = `$.observationTargets[${index}]`;
            const target = observationTarget(
              object(value, path, ["viewId", "entityId"]),
              path,
            );
            unique(
              JSON.stringify([target.viewId, target.entityId]),
              targets,
              path,
            );
            return target;
          },
        );
  if (observationTargets.length) required.add("runtime-observations");
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
    if (integer(link.latencyMs, `${path}.latencyMs`, 3600000) > 0)
      required.add("link-latency");
  });
  for (const actor of actors)
    if (!linked.has(actor))
      invalid("$.links", `missing bidirectional link for ${actor}`);
  const publications = new Set<string>();
  list(doc.publications, "$.publications").forEach((value, i) => {
    const path = `$.publications[${i}]`;
    const publication = object(value, path, ["id", "body"]);
    unique(text(publication.id, `${path}.id`), publications, `${path}.id`);
    // The full publication belongs to the runtime parser, including arbitrary exact payload numbers.
    object(publication.body, `${path}.body`);
  });
  const eventIds = new Set<string>();
  const wallSettings: { atMs: number; wallMillis: number; path: string }[] = [];
  const kinds = [
    ...Object.keys(actionFields),
    ...(lifecycle ? Object.keys(runtimeActionFields) : []),
  ];
  list(doc.actions, "$.actions").forEach((value, i) => {
    const path = `$.actions[${i}]`;
    const entry = object(value, path);
    const kind = choice(entry.kind, `${path}.kind`, kinds);
    if (profile === fleetProfile && isRuntimeAction(kind))
      invalid(
        `${path}.kind`,
        "memory sequence fleet does not support runtime lifecycle or wall clock actions",
      );
    const fields = isRuntimeAction(kind)
      ? runtimeActionFields[kind]
      : ["actor", ...actionFields[kind as ActorActionKind]];
    object(entry, path, ["id", "atMs", "kind", ...fields]);
    unique(text(entry.id, `${path}.id`), eventIds, `${path}.id`);
    const atMs = integer(entry.atMs, `${path}.atMs`, until);
    if (isRuntimeAction(kind)) {
      if (kind === "service-stop")
        choice(entry.mode, `${path}.mode`, stopModes);
      if (kind === "wall-clock-set") {
        const clockPath = `${path}.wallMillis`;
        wallSettings.push({
          atMs,
          wallMillis: integer(entry.wallMillis, clockPath),
          path: clockPath,
        });
        required.add("wall-clock-adjustments");
      }
      return;
    }
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
  validateWallSchedule(until, wallSettings);
  list(doc.assertions, "$.assertions").forEach((value, i) => {
    const path = `$.assertions[${i}]`;
    const record = object(value, path);
    const kind = choice(
      record.kind,
      `${path}.kind`,
      lifecycle
        ? ["client-frames", "source-receipts", "runtime-snapshot"]
        : ["client-frames", "source-receipts"],
    );
    const assertion = object(value, path, [
      "id",
      "atMs",
      "kind",
      ...(kind === "runtime-snapshot" ? ["viewId", "entityId"] : ["actor"]),
      "expected",
    ]);
    unique(text(assertion.id, `${path}.id`), eventIds, `${path}.id`);
    integer(assertion.atMs, `${path}.atMs`, until);
    if (kind === "runtime-snapshot") {
      const target = observationTarget(assertion, path);
      if (!targets.has(JSON.stringify([target.viewId, target.entityId])))
        invalid(
          path,
          "runtime snapshot assertion requires a declared observation target",
        );
      runtimeObservation(assertion.expected, `${path}.expected`, target);
      return;
    }
    reference(
      assertion.actor,
      kind === "client-frames" ? clients : sources,
      `${path}.actor`,
    );
    observationList(assertion.expected, `${path}.expected`, kind, storage);
    required.add("observations");
  });
  const policies = retryPolicies(doc);
  if (policies.length) required.add("automatic-retry");
  if (receiptRules(doc).length) required.add("receipt-loss");
  return {
    format: versions.scenario,
    storage,
    profile,
    observationTargets,
    canonical: encodeJson(doc),
    document: doc,
    requiredCapabilities: [...required].sort(),
    admittedActions: admitLifecycle(doc, lifecycle, policies),
    retryPolicies: policies,
  };
}

function validateWallSchedule(
  until: number,
  settings: { atMs: number; wallMillis: number; path: string }[],
) {
  // Sorting is stable. Equal-time settings are applied in declared order.
  settings.sort((a, b) => a.atMs - b.atMs);
  for (const [index, anchor] of settings.entries()) {
    const end = settings[index + 1]?.atMs ?? until;
    if (!Number.isSafeInteger(anchor.wallMillis + (end - anchor.atMs)))
      invalid(
        anchor.path,
        "wall-clock-set overflows safe integer before the next setting or horizon",
      );
  }
}

/** Default deny: callers must explicitly supply capabilities after runtime/profile admission. */
export const qualifiedDocumentCapabilities: readonly string[] = [];
export function requireExecutionCapabilities(
  document: TimelineDocument,
  supported: readonly string[] = qualifiedDocumentCapabilities,
): void {
  const missing = document.requiredCapabilities.filter(
    (item) => !supported.includes(item),
  );
  if (missing.length)
    throw new Error(
      `unsupported-execution: ${missing.join(", ")}; execution capabilities have not been admitted`,
    );
}
