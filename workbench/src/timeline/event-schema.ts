import { encodeJson, type Json } from "./json.js";
import {
  clientEnvelope,
  observationList,
  receiptEnvelope,
  snapshotEnvelope,
} from "./envelopes.js";
import { choice, integer, invalid, object, text } from "./validation.js";

export const actionFields: Record<string, string[]> = {
  "source-send": ["publication"],
  "source-retry": ["publication"],
  "client-subscribe": ["viewId", "entityId"],
  "client-unsubscribe": ["viewId", "entityId"],
  connect: [],
  disconnect: [],
  "writer-stall": [],
  "writer-release": ["fail"],
};

/** Closed event wrappers; arbitrary domain values live only inside full envelopes. */
export function eventData(
  kind: string,
  value: Json | undefined,
  path: string,
  time: number,
  until: number,
) {
  const data = object(value, path);
  if (kind.startsWith("retry-")) {
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
      Object.keys(actionFields),
    );
    object(data, path, ["actionId", "actionKind", ...actionFields[actionKind]]);
    text(data.actionId, `${path}.actionId`);
    for (const field of actionFields[actionKind]) {
      if (field === "fail") {
        if (typeof data.fail !== "boolean")
          invalid(`${path}.fail`, "expected boolean");
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
    } else
      (channel === "source-receipt" ? receiptEnvelope : clientEnvelope)(
        data.envelope,
        `${path}.envelope`,
      );
    if (kind === "link-send")
      integer(
        data.deliverAtMs,
        `${path}.deliverAtMs`,
        Number.MAX_SAFE_INTEGER,
        time,
      );
    if (kind === "dropped") text(data.reason, `${path}.reason`);
  } else if (kind === "assertion") {
    object(data, path, [
      "assertionId",
      "assertionKind",
      "atMs",
      "passed",
      "expected",
      "actual",
    ]);
    text(data.assertionId, `${path}.assertionId`);
    const assertionKind = choice(data.assertionKind, `${path}.assertionKind`, [
      "client-frames",
      "source-receipts",
    ]);
    if (integer(data.atMs, `${path}.atMs`, until) !== time)
      invalid(path, "assertion time differs from agenda key");
    if (typeof data.passed !== "boolean")
      invalid(`${path}.passed`, "expected boolean");
    observationList(data.expected, `${path}.expected`, assertionKind);
    observationList(data.actual, `${path}.actual`, assertionKind);
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
    const validate =
      kind === "receipt"
        ? receiptEnvelope
        : kind === "frame"
          ? clientEnvelope
          : snapshotEnvelope;
    validate(data.envelope, `${path}.envelope`);
  }
}
