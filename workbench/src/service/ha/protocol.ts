import { Decimal, parseJson, type Json } from "../../json/lossless.js";

export const mediaType = "application/vnd.zooglass.ha-v1+json";
export const subprotocol = "zooglass.ha.v1";
export const maximumCounter = 9223372036854775807n;
export type ObjectValue = { [key: string]: Json };
export type Kind =
  | "hello"
  | "snapshot"
  | "notFound"
  | "subscribed"
  | "baseline"
  | "update"
  | "unsubscribed"
  | "requestError"
  | "receipt";
export interface Envelope {
  kind: Kind;
  incarnation: string;
  generation: bigint;
  contentRevision: bigint;
  authorityRevision: bigint;
  payload: ObjectValue;
}
export interface Refusal {
  error: "accessDenied" | "accessUnavailable";
  subscription: string;
}
export class ProtocolFailure extends Error {}
/** Valid wire data cannot be applied to this membership; reopen from a fresh baseline. */
export class OrderingFailure extends Error {}
export class IncarnationChanged extends Error {}
export class AccessFailure extends Error {}

export function object(value: Json | undefined): ObjectValue {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value instanceof Decimal
  ) {
    throw new ProtocolFailure("Expected an object");
  }
  return value;
}
export function keys(value: ObjectValue, expected: string[]): void {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (
    actual.length !== required.length ||
    actual.some((key, index) => key !== required[index])
  ) {
    throw new ProtocolFailure("Unexpected message members");
  }
}
export function text(value: Json | undefined): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ProtocolFailure("Expected nonempty text");
  }
  return value;
}
export function runtimeIncarnation(value: Json | undefined): string {
  const incarnation = text(value);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      incarnation,
    )
  ) {
    throw new ProtocolFailure("Invalid incarnation");
  }
  return incarnation;
}
export function counter(value: Json | undefined, positive = false): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,18})$/.test(value)) {
    throw new ProtocolFailure("Invalid exact counter");
  }
  const parsed = BigInt(value);
  if (parsed > maximumCounter || (positive && parsed === 0n)) {
    throw new ProtocolFailure("Counter out of range");
  }
  return parsed;
}
function integer(value: Json | undefined): void {
  if (!(value instanceof Decimal)) {
    throw new ProtocolFailure("Expected numeric metadata");
  }
  counter(value.text);
}
function strings(value: Json | undefined): void {
  if (!Array.isArray(value)) {
    throw new ProtocolFailure("Expected text array");
  }
  value.forEach(text);
}
function nullableText(value: Json | undefined): void {
  if (value !== null) {
    text(value);
  }
}
function snapshot(value: Json): void {
  const s = object(value);
  keys(s, [
    "viewId",
    "entityId",
    "version",
    "data",
    "provenance",
    "publicationSequences",
    "status",
  ]);
  text(s.viewId);
  text(s.entityId);
  integer(s.version);
  object(s.data);
  object(s.status);
  for (const item of Object.values(object(s.provenance))) {
    const p = object(item);
    keys(p, ["sourceId", "epoch", "sourceEntityId"]);
    Object.values(p).forEach(text);
  }
  for (const item of Object.values(object(s.publicationSequences))) {
    if (!Array.isArray(item)) {
      throw new ProtocolFailure("Invalid publication sequences");
    }
    item.forEach(integer);
  }
}
function receipt(p: ObjectValue): void {
  keys(p, [
    "status",
    "reason",
    "stream",
    "publicationSequence",
    "version",
    "changedViews",
    "targets",
  ]);
  if (!["committed", "duplicate", "rejected"].includes(text(p.status))) {
    throw new ProtocolFailure("Unexpected receipt status");
  }
  text(p.reason);
  if (p.stream !== null) {
    const stream = object(p.stream);
    keys(stream, ["sourceId", "epoch", "sourceEntityId"]);
    Object.values(stream).forEach(text);
  }
  if (p.publicationSequence !== null) {
    integer(p.publicationSequence);
  }
  if (p.version !== null) {
    integer(p.version);
  }
  strings(p.changedViews);
  if (!Array.isArray(p.targets)) {
    throw new ProtocolFailure("Invalid receipt targets");
  }
  for (const target of p.targets) {
    const t = object(target);
    keys(t, [
      "viewId",
      "entityId",
      "status",
      "reason",
      "changedFields",
      "fields",
    ]);
    text(t.viewId);
    nullableText(t.entityId);
    text(t.status);
    nullableText(t.reason);
    strings(t.changedFields);
    if (!Array.isArray(t.fields)) {
      throw new ProtocolFailure("Invalid field outcomes");
    }
    for (const field of t.fields) {
      const f = object(field);
      keys(f, ["field", "status", "reason", "changed"]);
      text(f.field);
      text(f.status);
      nullableText(f.reason);
      if (typeof f.changed !== "boolean") {
        throw new ProtocolFailure("Invalid changed flag");
      }
    }
  }
}
function payload(kind: Kind, p: ObjectValue): void {
  switch (kind) {
    case "hello":
    case "notFound":
      keys(p, []);
      break;
    case "snapshot":
      snapshot(p);
      break;
    case "subscribed":
    case "unsubscribed":
      keys(
        p,
        kind === "subscribed"
          ? ["subscription", "viewId", "entityId", "recovery"]
          : ["subscription", "viewId", "entityId"],
      );
      counter(p.subscription, true);
      text(p.viewId);
      text(p.entityId);
      if (kind === "subscribed" && p.recovery !== "freshSnapshot") {
        throw new ProtocolFailure("Unsupported recovery");
      }
      break;
    case "baseline":
    case "update":
      keys(p, ["subscription", "snapshot"]);
      counter(p.subscription, true);
      snapshot(p.snapshot);
      break;
    case "requestError":
      keys(p, ["code", "subscription"]);
      if (p.code === "invalidRequest" && p.subscription === null) {
        break;
      }
      if (p.code !== "unknownView") {
        throw new ProtocolFailure("Unknown request error");
      }
      counter(p.subscription, true);
      break;
    case "receipt":
      receipt(p);
      break;
  }
}
/** Decimal metadata and domain payloads remain exact, including above Number.MAX_SAFE_INTEGER. */
export function decode(raw: string, maxBytes: number): Envelope | Refusal {
  if (Buffer.byteLength(raw) > maxBytes) {
    throw new ProtocolFailure("Message exceeds byte limit");
  }
  let p: ObjectValue;
  try {
    p = object(parseJson(raw, maxBytes));
  } catch {
    throw new ProtocolFailure("Invalid bounded JSON");
  }
  if (Object.hasOwn(p, "error")) {
    keys(p, ["error", "subscription"]);
    counter(p.subscription, true);
    if (
      Buffer.byteLength(raw) > 96 ||
      (p.error !== "accessDenied" && p.error !== "accessUnavailable")
    ) {
      throw new ProtocolFailure("Invalid subscription refusal");
    }
    return { error: p.error, subscription: text(p.subscription) };
  }
  keys(p, [
    "kind",
    "incarnation",
    "generation",
    "contentRevision",
    "authorityRevision",
    "payload",
  ]);
  const kind = text(p.kind) as Kind;
  if (
    ![
      "hello",
      "snapshot",
      "notFound",
      "subscribed",
      "baseline",
      "update",
      "unsubscribed",
      "requestError",
      "receipt",
    ].includes(kind)
  ) {
    throw new ProtocolFailure("Unknown message kind");
  }
  const incarnation = runtimeIncarnation(p.incarnation);
  const envelope = {
    kind,
    incarnation,
    generation: counter(p.generation, true),
    contentRevision: counter(p.contentRevision),
    authorityRevision: counter(p.authorityRevision),
    payload: object(p.payload),
  };
  if (envelope.contentRevision > envelope.authorityRevision) {
    throw new ProtocolFailure("Invalid revision ordering");
  }
  payload(kind, envelope.payload);
  return envelope;
}
