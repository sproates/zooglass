/** Fixed M1/S1 transcription and offline checks; never computes recovered state. */
import assert from "node:assert/strict";
import { parseTimelineDocument } from "../src/timeline/contract.js";
import { canonicalJson } from "../src/timeline/json.js";
import type { SourcePublication } from "../src/execution/publication-receipt.js";
import { digest, type cleanRecoverySource } from "./recovery-evidence.js";

export const recoveryParityCases = ["m1", "s1"] as const;
export type RecoveryParityCase = (typeof recoveryParityCases)[number];
type Body = Omit<SourcePublication, "entityId"> & { sourceEntityId: string };
type Frame = Record<string, unknown> & {
  type: string;
  viewId: string;
  entityId: string;
  version?: number;
};
type Action = {
  id: string;
  atMs: number;
  kind: string;
  actor?: string;
  publication?: string;
  viewId?: string;
  entityId?: string;
  mode?: string;
};
type Assertion = {
  id: string;
  atMs: number;
  kind: string;
  actor?: string;
  viewId?: string;
  entityId?: string;
  expected: unknown;
};
type Base = { id: string; atMs: number; generation: number };
export type RecoveryServiceStep = Base &
  (
    | { kind: "connect"; actor: string; endpoint: "/events" | "/views/live" }
    | {
        kind: "subscribe";
        connection: string;
        request: object;
        acknowledgement: object;
        expected: Frame;
      }
    | { kind: "publish"; connection: string; body: Body; expected: unknown }
    | {
        kind: "http";
        viewId: string;
        entityId: string;
        scope: "data" | "snapshot";
        expected: unknown;
      }
    | { kind: "stop" | "start" }
  );

// This is the two accepted service comparisons, not a general V4 service executor.
const schedule = [
  ["connect-source", 0, "connect"],
  ["connect-observer", 0, "connect"],
  ["subscribe-a", 1, "client-subscribe"],
  ["subscribe-b", 2, "client-subscribe"],
  ["send-a-10", 10, "source-send"],
  ["send-b-10", 15, "source-send"],
  ["send-a-12", 20, "source-send"],
  ["send-a-11", 30, "source-send"],
  ["send-b-11", 35, "source-send"],
  ["stop", 50, "service-stop"],
  ["start", 60, "service-start"],
  ["reconnect-source", 61, "connect"],
  ["reconnect-observer", 61, "connect"],
  ["resubscribe", 62, "client-subscribe"],
  ["retry-original", 70, "source-retry"],
];

export function recoveryServicePlan(
  name: RecoveryParityCase,
  scenario: string,
  configuration: string,
) {
  assert.ok(
    recoveryParityCases.includes(name),
    "Expected M1 or S1 service comparison",
  );
  assert.ok(
    Buffer.byteLength(scenario) <= 1024 * 1024 &&
      Buffer.byteLength(configuration) <= 1024 * 1024,
  );
  const parsed = parseTimelineDocument(scenario);
  assert.equal(parsed.format, "timeline-simulation/v4");
  assert.equal(parsed.profile, "static-views-restart-v1");
  const doc = JSON.parse(parsed.canonical);
  assert.equal(
    canonicalJson(JSON.stringify(doc)),
    parsed.canonical,
    "Lossless service inputs required",
  );
  const numbers = (value: unknown): void => {
    if (typeof value === "number")
      assert.ok(
        Number.isFinite(value) &&
          (!Number.isInteger(value) || Number.isSafeInteger(value)),
        "Unsafe service input number",
      );
    else if (value !== null && typeof value === "object")
      Object.values(value).forEach(numbers);
  };
  numbers(doc);
  assert.equal(doc.runtime.configuration, "runtime.json");
  assert.equal(
    doc.runtime.sha256,
    digest(configuration),
    "Exact configuration bytes",
  );
  const storage = name === "m1" ? "memory" : "sqlite";
  assert.equal(doc.runtime.storage, storage);
  assert.equal(JSON.parse(configuration).storage, storage);
  const actions = doc.actions as Action[];
  assert.deepEqual(
    actions.map((a) => [a.id, a.atMs, a.kind]),
    schedule,
    "Unsupported service action schedule",
  );
  assert.equal(actions.find((a) => a.kind === "service-stop")!.mode, "orderly");
  assert.equal(doc.actors.length, 2);
  const source = doc.actors.find(
    (a: { role: string }) => a.role === "source",
  )?.id;
  const client = doc.actors.find(
    (a: { role: string }) => a.role === "client",
  )?.id;
  assert.ok(source && client);
  const assertions = doc.assertions as Assertion[];
  const httpAssertions = assertions.filter((a) =>
    ["runtime-data", "runtime-snapshot"].includes(a.kind),
  );
  assert.deepEqual(
    httpAssertions.map((a) => [a.id, a.atMs, a.kind]),
    [
      ["data-a-10", 10, "runtime-data"],
      ["data-b-10", 15, "runtime-data"],
      ["data-a-12", 20, "runtime-data"],
      ["data-a-11", 30, "runtime-data"],
      ["data-b-11", 35, "runtime-data"],
      ["stored-kiln-a", 40, "runtime-snapshot"],
      ["stored-kiln-b", 40, "runtime-snapshot"],
      ...(name === "s1" ? [["second-view-before", 40, "runtime-data"]] : []),
      ["restored-a", 60, "runtime-snapshot"],
      ["restored-b", 60, "runtime-snapshot"],
      ...(name === "s1" ? [["second-view-restored", 60, "runtime-data"]] : []),
      ["after-retry", 70, "runtime-data"],
    ],
    "Complete reviewed HTTP checkpoints",
  );
  const literal = (id: string, kind: string) => {
    const matches = assertions.filter((a) => a.id === id && a.kind === kind);
    assert.equal(matches.length, 1, `Missing literal ${id}`);
    return matches[0].expected;
  };
  const receipts = literal("retry-receipts", "source-receipts") as unknown[];
  assert.equal(receipts.length, 6);
  assert.deepEqual(
    receipts.slice(0, 5),
    literal("all-receipts", "source-receipts"),
  );
  const firstFrames = literal("all-client-frames", "client-frames") as Frame[];
  const finalFrames = literal("reconnected-frames", "client-frames") as Frame[];
  assert.deepEqual(finalFrames.slice(0, firstFrames.length), firstFrames);
  const reconnectFrames = finalFrames.slice(firstFrames.length);
  assert.equal(reconnectFrames.length, name === "m1" ? 3 : 2);
  assert.equal(doc.publications.length, 5);
  const connections = new Map<string, string>();
  let publicationIndex = 0;
  const steps: RecoveryServiceStep[] = [];
  for (const action of actions) {
    const base = {
      id: action.id,
      atMs: action.atMs,
      generation: action.atMs < 60 ? 1 : 2,
    };
    if (action.kind === "connect") {
      assert.ok(action.actor === source || action.actor === client);
      connections.set(action.actor!, action.id);
      steps.push({
        ...base,
        kind: "connect",
        actor: action.actor!,
        endpoint: action.actor === source ? "/events" : "/views/live",
      });
    } else if (action.kind === "client-subscribe") {
      assert.equal(action.actor, client);
      const frames = base.generation === 1 ? firstFrames : reconnectFrames;
      const index = frames.findIndex(
        (f) =>
          f.type === "subscribed" &&
          f.viewId === action.viewId &&
          f.entityId === action.entityId,
      );
      assert.ok(
        index >= 0 && frames[index + 1]?.type === "view-update",
        "Literal subscription baseline missing",
      );
      const expected = frames[index + 1];
      assert.equal(expected.viewId, action.viewId);
      assert.equal(expected.entityId, action.entityId);
      steps.push({
        ...base,
        kind: "subscribe",
        connection: connections.get(client)!,
        request: {
          action: "subscribe",
          viewId: action.viewId,
          entityId: action.entityId,
        },
        acknowledgement: frames[index],
        expected,
      });
    } else if (
      action.kind === "source-send" ||
      action.kind === "source-retry"
    ) {
      assert.equal(action.actor, source);
      const publication = doc.publications.find(
        (p: { id: string }) => p.id === action.publication,
      );
      assert.ok(publication);
      if (action.kind === "source-retry")
        assert.equal(
          action.publication,
          actions.find((a) => a.id === "send-a-10")!.publication,
        );
      steps.push({
        ...base,
        kind: "publish",
        connection: connections.get(source)!,
        body: publication.body,
        expected: receipts[publicationIndex++],
      });
    } else
      steps.push({
        ...base,
        kind: action.kind === "service-stop" ? "stop" : "start",
      });
  }
  for (const assertion of httpAssertions) {
    assert.ok(assertion.viewId && assertion.entityId);
    let expected = assertion.expected;
    if (assertion.kind === "runtime-snapshot") {
      const retained = expected as {
        outcome: string;
        snapshot: { version: number };
      };
      assert.equal(retained.outcome, "available");
      // Select an already-authored public envelope. Do not recreate runtime projection logic.
      const frames = finalFrames.filter(
        (f) =>
          f.type === "view-update" &&
          f.viewId === assertion.viewId &&
          f.entityId === assertion.entityId &&
          f.version === retained.snapshot.version,
      );
      assert.ok(frames.length > 0, `No public literal for ${assertion.id}`);
      for (const frame of frames) assert.deepEqual(frame, frames[0]);
      const snapshot: Record<string, unknown> = { ...frames[0] };
      delete snapshot.type;
      expected = snapshot;
    }
    steps.push({
      id: assertion.id,
      atMs: assertion.atMs,
      generation: assertion.atMs < 60 ? 1 : 2,
      kind: "http",
      viewId: assertion.viewId,
      entityId: assertion.entityId,
      scope: assertion.kind === "runtime-data" ? "data" : "snapshot",
      expected,
    });
  }
  steps.sort(
    (a, b) =>
      a.atMs - b.atMs || Number(a.kind === "http") - Number(b.kind === "http"),
  );
  return { storage, steps };
}

export type RecoveryServiceObservations = {
  connections: {
    id: string;
    actor: string;
    generation: number;
    endpoint: string;
    sent: string[];
    received: string[];
  }[];
  receipts: { action: string; connection: string; frame: number }[];
  http: { barrier: string; generation: number; status: number; raw: string }[];
  clientChecks: {
    barrier: string;
    connection: string;
    acknowledgement: number;
    frame: number;
  }[];
  lifecycle: {
    generation: number;
    event: "started" | "stopped";
    orderly?: true;
  }[];
  completedSteps: string[];
};

export function checkRecoveryServiceObservations(
  name: RecoveryParityCase,
  scenario: string,
  configuration: string,
  observed: RecoveryServiceObservations,
) {
  const plan = recoveryServicePlan(name, scenario, configuration);
  assert.deepEqual(
    observed.completedSteps,
    plan.steps.map((s) => s.id),
    "Complete service barriers",
  );
  assert.deepEqual(
    observed.lifecycle,
    [
      { generation: 1, event: "started" },
      { generation: 1, event: "stopped", orderly: true },
      { generation: 2, event: "started" },
      { generation: 2, event: "stopped", orderly: true },
    ],
    "Both service generations require observed orderly shutdown",
  );
  const connects = plan.steps.filter((s) => s.kind === "connect");
  assert.equal(observed.connections.length, connects.length);
  connects.forEach((step, i) => {
    const { sent, received, ...identity } = observed.connections[i];
    assert.deepEqual(identity, {
      id: step.id,
      actor: step.actor,
      generation: step.generation,
      endpoint: step.endpoint,
    });
    assert.ok(
      sent.length <= 10 && received.length <= 32,
      "Bounded socket observations",
    );
    const transmissions = plan.steps.filter(
      (s) =>
        (s.kind === "publish" || s.kind === "subscribe") &&
        s.connection === step.id,
    );
    assert.deepEqual(
      sent.map((raw) => JSON.parse(raw)),
      transmissions.map((s) =>
        s.kind === "publish"
          ? s.body
          : s.kind === "subscribe"
            ? s.request
            : undefined,
      ),
      "Exact authored socket inputs",
    );
    if (step.endpoint === "/events")
      assert.equal(
        received.length,
        transmissions.length,
        "One raw receipt per attempt",
      );
  });
  const publishes = plan.steps.filter((s) => s.kind === "publish");
  assert.equal(observed.receipts.length, publishes.length);
  publishes.forEach((step, i) => {
    const reference = observed.receipts[i];
    const connection = observed.connections.find(
      (c) => c.id === step.connection,
    )!;
    const index = publishes
      .filter((s) => s.connection === step.connection)
      .indexOf(step);
    assert.deepEqual(reference, {
      action: step.id,
      connection: step.connection,
      frame: index,
    });
    assert.deepEqual(
      JSON.parse(connection.received[index]),
      step.expected,
      `Full receipt: ${step.id}`,
    );
  });
  const checks = plan.steps.filter((s) => s.kind === "http");
  assert.equal(observed.http.length, checks.length);
  checks.forEach((step, i) => {
    const response = observed.http[i];
    assert.equal(response.barrier, step.id);
    assert.equal(response.generation, step.generation);
    assert.equal(response.status, 200);
    const snapshot = JSON.parse(response.raw);
    assert.equal(snapshot.viewId, step.viewId);
    assert.equal(snapshot.entityId, step.entityId);
    assert.deepEqual(
      step.scope === "data" ? snapshot.data : snapshot,
      step.expected,
      `HTTP literal: ${step.id}`,
    );
  });
  const subscriptions = plan.steps.filter((s) => s.kind === "subscribe");
  assert.equal(observed.clientChecks.length, subscriptions.length);
  subscriptions.forEach((step, i) => {
    const reference = observed.clientChecks[i];
    assert.equal(reference.barrier, step.id);
    assert.equal(
      reference.connection,
      step.connection,
      "Snapshot must belong to the new connection",
    );
    assert.ok(
      Number.isSafeInteger(reference.acknowledgement) &&
        reference.acknowledgement >= 0,
    );
    assert.ok(
      Number.isSafeInteger(reference.frame) &&
        reference.frame > reference.acknowledgement,
    );
    const connection = observed.connections.find(
      (c) => c.id === step.connection,
    )!;
    assert.deepEqual(
      JSON.parse(connection.received[reference.acknowledgement]),
      step.acknowledgement,
    );
    assert.deepEqual(
      JSON.parse(connection.received[reference.frame]),
      step.expected,
      `Full subscription snapshot: ${step.id}`,
    );
  });
  return {
    publications: publishes.length,
    checkpoints: checks.length,
    clientSnapshots: subscriptions.length,
    generations: 2,
  };
}

export const recoveryParitySources = [
  "scripts/recovery-service-parity.ts",
  "scripts/recovery-service-observations.ts",
  "scripts/recovery-evidence.ts",
  "scripts/static-evidence.ts",
  "scripts/control-evidence.ts",
  "scripts/service-parity-socket.ts",
  "src/execution/sockets.ts",
  "src/execution/publication-receipt.ts",
  "src/service/zooglass-session.ts",
  "src/service/protected-session.ts",
  "src/service/runtime-configuration.ts",
  "src/service/runtime-contract.ts",
  "package-lock.json",
];
export type RecoveryServiceProvenance = {
  workbench: string;
  service: string;
  core: string;
  scenario: string;
  configuration: string;
  files: Record<string, string>;
};
export type RecoveryServiceEvidence = RecoveryServiceObservations & {
  format: "recovery-service-parity/v1";
  case: RecoveryParityCase;
  source: Awaited<ReturnType<typeof cleanRecoverySource>> | null;
  revision: string;
  qualification: boolean;
  complete: boolean;
  passed: boolean;
  errors: string[];
  matchedCoreClasses: number;
  provenanceBefore: RecoveryServiceProvenance;
  provenanceAfter: RecoveryServiceProvenance;
};

export function checkRecoveryServiceEvidence(
  evidence: RecoveryServiceEvidence,
  scenario: string,
  configuration: string,
) {
  assert.equal(evidence.format, "recovery-service-parity/v1");
  assert.equal(evidence.qualification, true);
  assert.equal(evidence.complete, true);
  assert.equal(evidence.passed, true);
  assert.deepEqual(evidence.errors, []);
  assert.ok(evidence.source, "Missing qualified source identity");
  assert.match(evidence.revision, /^[0-9a-f]{40}$/);
  assert.equal(evidence.source.revision, evidence.revision);
  assert.ok(
    Number.isSafeInteger(evidence.matchedCoreClasses) &&
      evidence.matchedCoreClasses > 0,
  );
  const identity = evidence.provenanceBefore;
  assert.deepEqual(evidence.provenanceAfter, identity);
  assert.equal(evidence.source.workbenchSha256, identity.workbench);
  assert.deepEqual(
    Object.keys(identity.files).sort(),
    [...recoveryParitySources].sort(),
  );
  for (const hash of [
    identity.workbench,
    identity.service,
    identity.core,
    identity.scenario,
    identity.configuration,
    ...Object.values(identity.files),
  ])
    assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(identity.scenario, digest(scenario));
  assert.equal(identity.configuration, digest(configuration));
  for (const path of recoveryParitySources.filter((path) =>
    path.startsWith("scripts/"),
  ))
    assert.equal(
      evidence.source.files.find((file) => file.path === path)?.sha256,
      identity.files[path],
      "Qualified helper identity mismatch",
    );
  for (const [file, hash] of [
    ["scenario.json", identity.scenario],
    ["runtime.json", identity.configuration],
  ]) {
    assert.equal(
      evidence.source.files.find(
        (f) =>
          f.path ===
          `scenarios/timeline-static-recovery/${evidence.case}/${file}`,
      )?.sha256,
      hash,
    );
  }
  return checkRecoveryServiceObservations(
    evidence.case,
    scenario,
    configuration,
    evidence,
  );
}
