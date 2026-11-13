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
  if (kind === "action") {
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
  } else if (kind === "delivered" || kind === "dropped") {
    object(data, path, [
      "messageId",
      "channel",
      "envelope",
      ...(kind === "dropped" ? ["reason"] : []),
    ]);
    text(data.messageId, `${path}.messageId`);
    const channel = choice(data.channel, `${path}.channel`, [
      "source-receipt",
      "client-frame",
    ]);
    (channel === "source-receipt" ? receiptEnvelope : clientEnvelope)(
      data.envelope,
      `${path}.envelope`,
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
    object(data, path, ["envelope"]);
    const validate =
      kind === "receipt"
        ? receiptEnvelope
        : kind === "frame"
          ? clientEnvelope
          : snapshotEnvelope;
    validate(data.envelope, `${path}.envelope`);
  }
}
