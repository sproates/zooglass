import { encodeJson, type Json } from "./json.js";
import {
  clientEnvelope,
  installedSnapshot,
  observationList,
  observationTarget,
  receiptEnvelope,
  runtimeObservation,
  snapshotEnvelope,
} from "./envelopes.js";
import { choice, integer, invalid, list, object, text } from "./validation.js";

export const actionFields = {
  "source-send": ["publication"],
  "source-retry": ["publication"],
  "client-subscribe": ["viewId", "entityId"],
  "client-unsubscribe": ["viewId", "entityId"],
  connect: [],
  disconnect: [],
  "writer-stall": [],
  "writer-release": ["fail"],
};
export type ActorActionKind = keyof typeof actionFields;
export const serviceActionFields = {
  "service-stop": ["mode"],
  "service-start": [],
};
export type ServiceActionKind = keyof typeof serviceActionFields;
export const stopModes = ["orderly", "abrupt"] as const;
export const lifecycleEventKinds = [
  "runtime-initialized",
  "runtime-observation",
  "connection-outcome",
  "attempt-outcome",
] as const;

export function isServiceAction(kind: string): kind is ServiceActionKind {
  return Object.hasOwn(serviceActionFields, kind);
}

/** Closed event wrappers; arbitrary domain values live only inside full envelopes. */
export function eventData(
  kind: string,
  value: Json | undefined,
  path: string,
  time: number,
  until: number,
  version: 1 | 2 = 1,
  storage: "memory" | "sqlite" | undefined = version === 1
    ? "memory"
    : undefined,
) {
  const data = object(value, path);
  if (kind === "runtime-initialized" && version === 2) {
    object(data, path, [
      "startTimeMs",
      "wallMillis",
      "monotonicMs",
      "snapshots",
    ]);
    if (integer(data.startTimeMs, `${path}.startTimeMs`, until) !== time)
      invalid(path, "runtime start time differs from agenda key");
    integer(
      data.wallMillis,
      `${path}.wallMillis`,
      Number.MAX_SAFE_INTEGER,
      time,
    );
    integer(data.monotonicMs, `${path}.monotonicMs`, 0);
    const targets = new Set<string>();
    list(data.snapshots, `${path}.snapshots`, 64).forEach((value, index) => {
      const snapshotPath = `${path}.snapshots[${index}]`;
      const snapshot = installedSnapshot(value, snapshotPath);
      const id = JSON.stringify([snapshot.viewId, snapshot.entityId]);
      if (targets.has(id))
        invalid(snapshotPath, "duplicate observation target");
      targets.add(id);
    });
  } else if (kind === "runtime-observation" && version === 2) {
    const { viewId, entityId, ...result } = data;
    runtimeObservation(
      result,
      path,
      observationTarget({ viewId, entityId }, path),
    );
  } else if (
    (kind === "connection-outcome" || kind === "attempt-outcome") &&
    version === 2
  ) {
    const attempt = kind === "attempt-outcome";
    object(
      data,
      path,
      attempt ? ["publication", "attempt", "outcome"] : ["outcome"],
    );
    choice(data.outcome, `${path}.outcome`, ["connection-unavailable"]);
    if (attempt) {
      text(data.publication, `${path}.publication`);
      integer(data.attempt, `${path}.attempt`, 1000, 1);
    }
  } else if (kind.startsWith("retry-")) {
    object(data, path, [
      "actionId",
      "attempt",
      ...(kind === "retry-lifecycle" ? ["operation"] : ["publication"]),
      ...(kind === "retry-status" ? ["status"] : []),
    ]);
    text(data.actionId, `${path}.actionId`);
    integer(data.attempt, `${path}.attempt`, 10, 1);
    if (kind === "retry-lifecycle")
      choice(data.operation, `${path}.operation`, ["connect", "disconnect"]);
    else text(data.publication, `${path}.publication`);
    if (kind === "retry-status")
      choice(data.status, `${path}.status`, [
        "acknowledged",
        "late-receipt",
        "timed-out",
        "exhausted",
      ]);
  } else if (kind === "fault-decision") {
    object(data, path, [
      "algorithm",
      "drawIndex",
      "digest",
      "sample",
      "rejected",
      "lost",
      "numerator",
      "denominator",
      "ruleId",
      "actionId",
      "messageId",
      "attempt",
    ]);
    choice(data.algorithm, `${path}.algorithm`, ["sha256-u32-rejection-v1"]);
    for (const field of ["ruleId", "actionId", "messageId"])
      text(data[field], `${path}.${field}`);
    integer(data.attempt, `${path}.attempt`, 1000, 1);
    integer(data.drawIndex, `${path}.drawIndex`, 15);
    const digest = text(data.digest, `${path}.digest`);
    if (!/^[a-f0-9]{64}$/.test(digest)) invalid(path, "expected draw SHA-256");
    const sample = integer(data.sample, `${path}.sample`, 4294967295);
    const denominator = integer(
      data.denominator,
      `${path}.denominator`,
      1000000,
      1,
    );
    const numerator = integer(data.numerator, `${path}.numerator`, denominator);
    const rejected =
      sample >= Math.floor(4294967296 / denominator) * denominator;
    if (
      sample !== parseInt(digest.slice(0, 8), 16) ||
      data.rejected !== rejected ||
      data.lost !== (!rejected && sample % denominator < numerator)
    )
      invalid(path, "draw outcome disagrees with sample/probability");
  } else if (kind === "runtime-command") {
    const op = choice(data.op, `${path}.op`, [
      "initialize-document",
      "observe",
      "shutdown",
      "disconnect",
    ]);
    object(data, path, [
      "op",
      ...(op === "initialize-document"
        ? ["configurationSha256", "epochMillis"]
        : []),
      ...(op === "disconnect" ? ["reason", "messageId"] : []),
    ]);
    if (op === "initialize-document") {
      if (!/^[a-f0-9]{64}$/.test(text(data.configurationSha256, path)))
        invalid(path, "expected configuration SHA-256");
      integer(data.epochMillis, `${path}.epochMillis`);
    }
    if (op === "disconnect") {
      choice(data.reason, `${path}.reason`, ["receipt-loss"]);
      text(data.messageId, `${path}.messageId`);
    }
  } else if (kind === "task-dispatched") {
    object(data, path, ["taskId"]);
    text(data.taskId, `${path}.taskId`);
  } else if (kind === "connection-closed") {
    object(data, path, ["code"]);
    integer(data.code, `${path}.code`, 4999, 1000);
  } else if (kind === "handoff") {
    object(data, path, ["messageId", "envelope"]);
    text(data.messageId, `${path}.messageId`);
    clientEnvelope(data.envelope, `${path}.envelope`);
  } else if (kind === "action") {
    const actionKind = choice(
      data.actionKind,
      `${path}.actionKind`,
      version === 2
        ? [...Object.keys(actionFields), ...Object.keys(serviceActionFields)]
        : Object.keys(actionFields),
    ) as ActorActionKind | ServiceActionKind;
    const fields = isServiceAction(actionKind)
      ? serviceActionFields[actionKind]
      : actionFields[actionKind];
    object(data, path, ["actionId", "actionKind", ...fields]);
    text(data.actionId, `${path}.actionId`);
    for (const field of fields) {
      if (field === "fail") {
        if (typeof data.fail !== "boolean")
          invalid(`${path}.fail`, "expected boolean");
      } else if (field === "mode") {
        choice(data.mode, `${path}.mode`, stopModes);
      } else text(data[field], `${path}.${field}`);
    }
  } else if (kind === "scheduled") {
    object(data, path, ["taskId", "atMs", "phase", "taskKind"]);
    text(data.taskId, `${path}.taskId`);
    integer(data.atMs, `${path}.atMs`, Number.MAX_SAFE_INTEGER, time);
    integer(data.phase, `${path}.phase`, 2);
    text(data.taskKind, `${path}.taskKind`);
  } else if (kind === "cancelled") {
    object(data, path, ["taskId"]);
    text(data.taskId, `${path}.taskId`);
  } else if (
    kind === "link-send" ||
    kind === "delivered" ||
    kind === "dropped"
  ) {
    object(data, path, [
      "messageId",
      "channel",
      "envelope",
      ...(kind === "dropped" ? ["reason"] : []),
      ...(kind === "link-send" ? ["deliverAtMs"] : []),
    ]);
    text(data.messageId, `${path}.messageId`);
    const channel = choice(data.channel, `${path}.channel`, [
      "source-receipt",
      "client-frame",
      "source-publication",
      "client-request",
    ]);
    if (channel === "source-publication")
      object(data.envelope, `${path}.envelope`);
    else if (channel === "client-request") {
      const envelope = object(data.envelope, `${path}.envelope`, [
        "action",
        "viewId",
        "entityId",
      ]);
      choice(envelope.action, `${path}.envelope.action`, [
        "subscribe",
        "unsubscribe",
      ]);
      text(envelope.viewId, `${path}.envelope.viewId`);
      text(envelope.entityId, `${path}.envelope.entityId`);
    } else if (channel === "source-receipt")
      receiptEnvelope(data.envelope, `${path}.envelope`, storage);
    else clientEnvelope(data.envelope, `${path}.envelope`);
    if (kind === "link-send")
      integer(
        data.deliverAtMs,
        `${path}.deliverAtMs`,
        Number.MAX_SAFE_INTEGER,
        time,
      );
    if (kind === "dropped") text(data.reason, `${path}.reason`);
  } else if (kind === "assertion") {
    const assertionKind = choice(
      data.assertionKind,
      `${path}.assertionKind`,
      version === 2
        ? ["client-frames", "source-receipts", "runtime-snapshot"]
        : ["client-frames", "source-receipts"],
    );
    object(data, path, [
      "assertionId",
      "assertionKind",
      "atMs",
      "passed",
      "expected",
      "actual",
      ...(assertionKind === "runtime-snapshot" ? ["viewId", "entityId"] : []),
    ]);
    text(data.assertionId, `${path}.assertionId`);
    if (integer(data.atMs, `${path}.atMs`, until) !== time)
      invalid(path, "assertion time differs from agenda key");
    if (typeof data.passed !== "boolean")
      invalid(`${path}.passed`, "expected boolean");
    if (assertionKind === "runtime-snapshot") {
      const target = observationTarget(data, path);
      runtimeObservation(data.expected, `${path}.expected`, target);
      runtimeObservation(data.actual, `${path}.actual`, target);
    } else {
      observationList(
        data.expected,
        `${path}.expected`,
        assertionKind,
        storage,
      );
      observationList(data.actual, `${path}.actual`, assertionKind, storage);
    }
    if (data.passed !== (encodeJson(data.expected) === encodeJson(data.actual)))
      invalid(
        path,
        "assertion result disagrees with complete expected/actual comparison",
      );
  } else {
    object(data, path, [
      "envelope",
      ...(Object.hasOwn(data, "messageId") ? ["messageId"] : []),
    ]);
    if (data.messageId !== undefined) text(data.messageId, `${path}.messageId`);
    if (kind === "receipt")
      receiptEnvelope(data.envelope, `${path}.envelope`, storage);
    else if (kind === "frame")
      clientEnvelope(data.envelope, `${path}.envelope`);
    else snapshotEnvelope(data.envelope, `${path}.envelope`);
  }
}
