/** Pure transcription and offline validation for the two ordinary-service comparisons. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { SourcePublication } from "../src/execution/publication-receipt.js";
import { parseTimelineDocument } from "../src/timeline/contract.js";
import { canonicalJson } from "../src/timeline/json.js";
const hash = (bytes: string | Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
export const staticParityCases = ["late-update", "mixed-modes"] as const;
export type CaseName = (typeof staticParityCases)[number];
type Body = Omit<SourcePublication, "entityId"> & { sourceEntityId: string };
type Action = {
  id: string;
  atMs: number;
  kind: string;
  actor: string;
  publication?: string;
  viewId?: string;
  entityId?: string;
};
type Check = {
  id: string;
  atMs: number;
  viewId: string;
  entityId: string;
  expected: object;
};
type Step =
  | { kind: "send"; id: string; atMs: number; actor: string; body: Body }
  | ({ kind: "check" } & Check);
type Observations = {
  connections: { actor: string; endpoint: string; received: string[] }[];
  http: { barrier: string; observedAt: number; status: number; raw: string }[];
  accepted: { send: string; actor: string; receipt: unknown }[];
  clientChecks: { barrier: string; actor: string; frame: number }[];
  barriers: string[];
};
export type Provenance = {
  workbench: string;
  files: Record<string, string>;
  service: string;
  core: string;
  scenario: string;
  configuration: string;
  legacy?: string;
  conversionReport?: string;
};
export const paritySources = [
  "scripts/static-service-parity.ts",
  "scripts/static-service-observations.ts",
  "scripts/service-parity-socket.ts",
  "src/execution/sockets.ts",
  "src/execution/publication-receipt.ts",
  "src/service/zooglass-session.ts",
  "src/service/protected-session.ts",
  "src/service/runtime-configuration.ts",
  "src/service/runtime-contract.ts",
  "package-lock.json",
];

/** A deliberately narrow transcription of reviewed inputs/barriers, never a view oracle. */
export function staticParityPlan(scenario: string, configuration: string) {
  const parsed = parseTimelineDocument(scenario);
  assert.equal(parsed.format, "timeline-simulation/v3");
  assert.equal(parsed.profile, "memory-static-views-v1");
  const document = JSON.parse(parsed.canonical);
  assert.equal(
    canonicalJson(JSON.stringify(document)),
    parsed.canonical,
    "Parity inputs must survive native-number serialization exactly",
  );
  const checkNumbers = (value: unknown): void => {
    if (typeof value === "number")
      assert.ok(
        Number.isFinite(value) &&
          (!Number.isInteger(value) || Number.isSafeInteger(value)),
        "Unsafe parity number",
      );
    else if (value !== null && typeof value === "object")
      Object.values(value).forEach(checkNumbers);
  };
  checkNumbers(document);
  assert.equal(
    document.runtime.sha256,
    hash(configuration),
    "Exact configuration bytes",
  );
  assert.ok(
    document.links.every((link: { latencyMs: number }) => link.latencyMs === 0),
    "Parity does not model link latency",
  );
  const actions = document.actions as Action[];
  assert.ok(
    actions.every((a) =>
      ["connect", "client-subscribe", "source-send"].includes(a.kind),
    ),
    "Parity supports initial connections/subscriptions and sends only",
  );
  const sends = actions.filter((a) => a.kind === "source-send");
  assert.ok(sends.length > 0 && sends.length <= 10, "Parity send bound");
  assert.equal(
    new Set(sends.map((a) => a.atMs)).size,
    sends.length,
    "Parity requires distinct send times",
  );
  const firstSend = Math.min(...sends.map((a) => a.atMs));
  const connections = actions.filter((a) => a.kind === "connect");
  assert.ok(
    connections.every((a) => a.atMs === 0),
    "Parity connects only initially",
  );
  assert.equal(
    new Set(connections.map((a) => a.actor)).size,
    connections.length,
    "No repeated connections",
  );
  assert.equal(
    connections.length,
    document.actors.length,
    "Every actor connects exactly once",
  );
  const subscriptions = actions.filter((a) => a.kind === "client-subscribe");
  assert.ok(
    subscriptions.every((a) => a.atMs < firstSend),
    "Subscriptions must precede all sends",
  );
  assert.equal(
    new Set(
      subscriptions.map((a) => JSON.stringify([a.actor, a.viewId, a.entityId])),
    ).size,
    subscriptions.length,
    "No repeated subscriptions",
  );
  const accepted = document.assertions.filter(
    (a: { kind: string }) => a.kind === "source-accepted",
  ) as (Action & { send: string })[];
  assert.equal(
    accepted.length,
    sends.length,
    "Every send requires its reviewed acceptance check",
  );
  for (const send of sends)
    assert.equal(
      accepted.filter(
        (a) =>
          a.send === send.id && a.actor === send.actor && a.atMs === send.atMs,
      ).length,
      1,
      "Acceptance must bind the exact send",
    );
  const checks = document.assertions.filter(
    (a: { kind: string }) => a.kind === "runtime-data",
  ) as Check[];
  assert.ok(
    checks.length > 0 && checks.length <= 10,
    "Parity checkpoint bound",
  );
  assert.ok(
    checks.every((a) => a.expected !== null),
    "Parity checks available data only",
  );
  assert.equal(
    new Set(sends.map((a) => a.publication)).size,
    document.publications.length,
    "Use each declared publication once",
  );
  const steps: Step[] = sends.map((a) => ({
    kind: "send",
    id: a.id,
    atMs: a.atMs,
    actor: a.actor,
    body: document.publications.find(
      (p: { id: string }) => p.id === a.publication,
    ).body,
  }));
  steps.push(...checks.map((a) => ({ ...a, kind: "check" as const })));
  steps.sort(
    (a, b) =>
      a.atMs - b.atMs || (a.kind === b.kind ? 0 : a.kind === "send" ? -1 : 1),
  );
  return {
    actors: document.actors as { id: string; role: "source" | "client" }[],
    subscriptions,
    steps,
  };
}

/** Recheck retained raw observations against authored literals, without running a service. */
export function checkStaticServiceObservations(
  scenario: string,
  configuration: string,
  observed: Observations,
) {
  const plan = staticParityPlan(scenario, configuration);
  assert.deepEqual(
    observed.connections.map((c) => c.actor),
    plan.actors.map((a) => a.id),
  );
  const sends = plan.steps.filter((s) => s.kind === "send");
  const checks = plan.steps.filter((s) => s.kind === "check");
  assert.equal(observed.accepted.length, sends.length);
  for (const actor of plan.actors) {
    const connection = observed.connections.find((c) => c.actor === actor.id)!;
    assert.equal(
      connection.endpoint,
      actor.role === "source" ? "/events" : "/views/live",
    );
    if (actor.role !== "source") continue;
    const actorSends = sends.filter((s) => s.actor === actor.id);
    assert.equal(
      connection.received.length,
      actorSends.length,
      "Exactly one raw receipt per send",
    );
    actorSends.forEach((send, i) => {
      const receipt = JSON.parse(connection.received[i]);
      assert.deepEqual(
        receipt.stream,
        {
          sourceId: send.body.sourceId,
          epoch: send.body.epoch,
          sourceEntityId: send.body.sourceEntityId,
        },
        `Receipt identity: ${send.id}`,
      );
      assert.equal(
        receipt.publicationSequence,
        send.body.publicationSequence,
        `Receipt sequence: ${send.id}`,
      );
      assert.ok(
        ["applied", "committed", "duplicate"].includes(receipt.status),
        `Receipt acceptance: ${send.id}`,
      );
      const recorded = observed.accepted[sends.indexOf(send)];
      assert.deepEqual(recorded, { send: send.id, actor: send.actor, receipt });
    });
  }
  assert.deepEqual(
    observed.barriers,
    checks.map((c) => c.id),
  );
  assert.equal(observed.http.length, checks.length);
  const expectedClientChecks: { barrier: string; actor: string }[] = [];
  checks.forEach((check, i) => {
    const response = observed.http[i];
    assert.equal(response.barrier, check.id);
    assert.equal(response.status, 200);
    const snapshot = JSON.parse(response.raw);
    assert.equal(snapshot.viewId, check.viewId);
    assert.equal(snapshot.entityId, check.entityId);
    assert.deepEqual(
      snapshot.data,
      check.expected,
      `${check.id}: retained HTTP data`,
    );
    for (const sub of plan.subscriptions.filter(
      (s) => s.viewId === check.viewId && s.entityId === check.entityId,
    )) {
      const retained = observed.clientChecks[expectedClientChecks.length];
      expectedClientChecks.push({ barrier: check.id, actor: sub.actor });
      assert.equal(retained.barrier, check.id);
      assert.equal(retained.actor, sub.actor);
      assert.ok(Number.isSafeInteger(retained.frame) && retained.frame >= 0);
      const frame = JSON.parse(
        observed.connections.find((c) => c.actor === sub.actor)!.received[
          retained.frame
        ],
      );
      assert.equal(frame.type, "view-update");
      assert.equal(frame.viewId, check.viewId);
      assert.equal(frame.entityId, check.entityId);
      assert.deepEqual(
        frame.data,
        check.expected,
        `${check.id}: retained client data`,
      );
    }
  });
  assert.equal(observed.clientChecks.length, expectedClientChecks.length);
  return {
    publications: sends.length,
    checkpoints: checks.length,
    clientCheckpoints: expectedClientChecks.length,
  };
}

export type StaticServiceEvidence = Observations & {
  format: string;
  case: string;
  revision: string;
  sourceDirty: boolean;
  qualification: boolean;
  complete: boolean;
  passed: boolean;
  errors: string[];
  matchedCoreClasses: number;
  provenanceBefore: Provenance;
  provenanceAfter: Provenance;
};

/** Qualification audit: success flags alone never substitute for raw observations. */
export function checkStaticServiceEvidence(
  evidence: StaticServiceEvidence,
  scenario: string,
  configuration: string,
) {
  assert.equal(evidence.format, "static-service-parity/v1");
  assert.ok(staticParityCases.includes(evidence.case as CaseName));
  assert.equal(evidence.qualification, true);
  assert.equal(evidence.sourceDirty, false);
  assert.equal(evidence.complete, true);
  assert.equal(evidence.passed, true);
  assert.deepEqual(evidence.errors, []);
  assert.match(evidence.revision, /^[a-f0-9]{40}$/);
  assert.ok(
    Number.isSafeInteger(evidence.matchedCoreClasses) &&
      evidence.matchedCoreClasses > 0,
  );
  const identity = evidence.provenanceBefore;
  assert.deepEqual(evidence.provenanceAfter, identity);
  assert.deepEqual(
    Object.keys(identity.files).sort(),
    [...paritySources].sort(),
  );
  for (const value of [
    ...Object.values(identity.files),
    identity.workbench,
    identity.service,
    identity.core,
    identity.scenario,
    identity.configuration,
  ])
    assert.match(value, /^[a-f0-9]{64}$/);
  assert.equal(identity.scenario, hash(scenario));
  assert.equal(identity.configuration, hash(configuration));
  const document = parseTimelineDocument(scenario);
  if (document.document.conversionReport !== undefined) {
    assert.match(identity.legacy ?? "", /^[a-f0-9]{64}$/);
    assert.match(identity.conversionReport ?? "", /^[a-f0-9]{64}$/);
  } else {
    assert.equal(identity.legacy, undefined);
    assert.equal(identity.conversionReport, undefined);
  }
  return checkStaticServiceObservations(scenario, configuration, evidence);
}
