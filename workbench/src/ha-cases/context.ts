import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { encodeJson, parseJson, type Json } from "../json/lossless.js";
import type { HaCluster } from "../ha-fixture/cluster.js";
import {
  decode,
  object,
  type Envelope,
  type ObjectValue,
} from "../service/ha/protocol.js";
import { NodeTransport } from "../service/ha/transport.js";
import type { Resource } from "../service/ha/viewer-state.js";

export type Owner = Awaited<ReturnType<HaCluster["readyOwner"]>>;
export interface CaseContext {
  cluster: HaCluster;
  signal: AbortSignal;
  record(name: string, data?: Json): void;
  pause(): Promise<void>;
  cancel(): Promise<void>;
}
export const resource: Resource = { viewId: "match", entityId: "42" };
export const maxBytes = 65536;
export function transport(ctx: CaseContext): NodeTransport {
  return new NodeTransport({
    origins: ctx.cluster.nodes.map((node) => node.viewer),
    ca: ctx.cluster.ca,
    bearer: "viewer",
    originHeader:
      ctx.cluster.mode === "applicationPolicy"
        ? "https://fixture-viewer.example"
        : undefined,
    maxBytes,
  });
}
export async function waitFor<T>(
  operation: () => Promise<T | undefined>,
  description: string,
  signal: AbortSignal,
  millis = 15000,
): Promise<T> {
  const deadline = performance.now() + millis;
  let last: unknown;
  while (performance.now() < deadline) {
    signal.throwIfAborted();
    try {
      const result = await operation();
      if (result !== undefined) return result;
    } catch (error) {
      last = error;
    }
    await delay(50, undefined, { signal });
  }
  throw new Error(`Timed out waiting for ${description}`, { cause: last });
}
export async function capture(
  ctx: CaseContext,
  index: number,
  target = resource,
): Promise<Envelope> {
  const reply = await transport(ctx).read(
    ctx.cluster.nodes[index].viewer,
    `/views?${new URLSearchParams({ viewId: target.viewId, entityId: target.entityId })}`,
    AbortSignal.any([ctx.signal, AbortSignal.timeout(5000)]),
  );
  const frame = decode(reply.body, maxBytes);
  assert.ok(!("error" in frame));
  assert.equal(frame.kind, "snapshot");
  assert.equal(reply.status, 200);
  ctx.record("snapshot", {
    node: String(index),
    generation: String(frame.generation),
    revision: String(frame.contentRevision),
    payload: frame.payload,
  });
  return frame;
}
export function publication(
  sourceId: string,
  sequence: number,
  type: string,
  payload: unknown,
  entityId = "42",
  epoch = "run",
): string {
  return JSON.stringify({
    sourceId,
    epoch,
    sourceEntityId: entityId,
    publicationSequence: sequence,
    type,
    payload,
  });
}
export async function publish(
  ctx: CaseContext,
  index: number,
  bytes: string,
): Promise<ObjectValue> {
  const result = await ctx.cluster.nodes[index].publish(bytes);
  assert.equal(
    result.status,
    "resolved",
    result.reason ?? "Publication unresolved",
  );
  assert.ok(result.receiptJson);
  const receipt = object(parseJson(result.receiptJson));
  ctx.record("receipt", { node: String(index), receipt });
  return receipt;
}
export async function takeover(
  ctx: CaseContext,
  previous: Owner,
  graceful = false,
): Promise<Owner> {
  const faultStarted = performance.now();
  await ctx.cluster.nodes[previous.index].kill(
    graceful ? "SIGTERM" : "SIGKILL",
  );
  await ctx.pause();
  const next = await waitFor(
    async () => {
      const owner = await ctx.cluster.readyOwner();
      return owner.index !== previous.index &&
        owner.generation > previous.generation
        ? owner
        : undefined;
    },
    "successor owner",
    ctx.signal,
  );
  assert.equal(next.incarnation, previous.incarnation);
  ctx.record("takeover", {
    elapsedMillis: String(Math.round(performance.now() - faultStarted)),
    timingBoundary: "termination-request-to-successor-readiness",
    from: String(previous.index),
    to: String(next.index),
    generation: String(next.generation),
    incarnation: next.incarnation,
  });
  return next;
}
export function exact(value: Json): string {
  return encodeJson(value);
}
