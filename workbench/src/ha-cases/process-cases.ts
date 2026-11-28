import assert from "node:assert/strict";
import { Decimal } from "../json/lossless.js";
import { Ownership } from "../service/ha/ownership.js";
import { HaProducer } from "../service/ha/producer.js";
import { HaViewer } from "../service/ha/viewer.js";
import { type ViewerEvent } from "../service/ha/viewer-state.js";
import { object } from "../service/ha/protocol.js";
import {
  type CaseContext,
  capture,
  maxBytes,
  publication,
  publish,
  resource,
  takeover,
  transport,
  waitFor,
} from "./context.js";
import { LostReceipt, next, rawGet, source } from "./wire.js";

const input = (sequence: number) =>
  publication("feed", sequence, "updated", { score: sequence });
function version(value: unknown): string {
  assert.ok(value instanceof Decimal);
  return value.text;
}
export async function case1(ctx: CaseContext): Promise<void> {
  const owner = await ctx.cluster.readyOwner();
  const statuses = await waitFor(
    async () => {
      const replies = await Promise.all(
        ctx.cluster.nodes.map((node) =>
          rawGet(ctx, node.viewer, "/ha/ready", ctx.cluster.credentials.probe),
        ),
      );
      // Concurrent readiness work may truthfully return busy503 on both candidates.
      // Return any serving observation; the assertions below must reject two200s.
      return replies.some((reply) => reply.status === 200)
        ? replies
        : undefined;
    },
    "a serving readiness observation",
    ctx.signal,
  );
  assert.equal(statuses.filter((reply) => reply.status === 200).length, 1);
  assert.equal(statuses.filter((reply) => reply.status === 503).length, 1);
  statuses.forEach((reply) => assert.equal(reply.body, ""));
  const snapshot = await capture(ctx, owner.index);
  assert.equal(version(snapshot.payload.version), "0");
  assert.equal(Object.keys(object(snapshot.payload.data)).length, 0);
  assert.equal(
    await ctx.cluster.sql(
      "SELECT count(*) FROM zooglass_runtime WHERE role='active';",
    ),
    "1",
  );
  ctx.record("one-active-empty", {
    node: String(owner.index),
    generation: String(owner.generation),
  });
}
export async function case2(ctx: CaseContext): Promise<void> {
  const owner = await ctx.cluster.readyOwner(),
    bytes = input(1);
  const original = await publish(ctx, owner.index, bytes);
  assert.equal(original.status, "committed");
  assert.equal(version(original.version), "1");
  const successor = await takeover(ctx, owner, true),
    retry = await publish(ctx, successor.index, bytes);
  assert.equal(retry.status, "duplicate");
  assert.equal(retry.reason, "alreadyCommitted");
  assert.deepEqual(retry.targets, original.targets);
  assert.equal(version(retry.version), "1");
  const snapshot = await capture(ctx, successor.index);
  assert.equal(version(snapshot.payload.version), "1");
  assert.equal(version(object(object(snapshot.payload.data).score).score), "1");
}
export async function case3(ctx: CaseContext): Promise<void> {
  const owner = await ctx.cluster.readyOwner(),
    channel = await source(ctx, owner.index);
  const token = await ctx.cluster.nodes[owner.index].armBarrier("write-before");
  const bytes = input(1);
  try {
    channel.send(bytes);
    await ctx.cluster.nodes[owner.index].waitBarrier("write-before", token);
    assert.equal(
      await ctx.cluster.sql("SELECT revision FROM zooglass_runtime;"),
      "0",
    );
    await ctx.cluster.nodes[owner.index].kill();
    await assert.rejects(next(ctx, channel));
    const successor = await waitFor(
      async () => {
        const value = await ctx.cluster.readyOwner();
        return value.index !== owner.index ? value : undefined;
      },
      "owner after precommit kill",
      ctx.signal,
    );
    const receipt = await publish(ctx, successor.index, bytes);
    assert.equal(receipt.status, "committed");
    assert.equal(version(receipt.version), "1");
    ctx.record("no-ack-before-commit", {
      revisionBefore: "0",
      retryVersion: "1",
    });
  } finally {
    channel.close();
  }
}
export async function case4(ctx: CaseContext): Promise<void> {
  const owner = await ctx.cluster.readyOwner();
  const origins = [
    ctx.cluster.nodes[owner.index].viewer,
    ctx.cluster.nodes[1 - owner.index].viewer,
  ];
  const gate = new LostReceipt(transport(ctx));
  const producer = new HaProducer({
    origins,
    transport: gate,
    ownership: new Ownership(),
    maxBytes,
  });
  let result: ReturnType<HaProducer["publish"]> | undefined;
  const observation = AbortSignal.any([ctx.signal, AbortSignal.timeout(10000)]);
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(observation.reason);
    if (observation.aborted) abort();
    else observation.addEventListener("abort", abort, { once: true });
  });
  try {
    result = producer.publish(input(1));
    const original = await Promise.race([
      gate.observed.promise,
      cancelled,
      result.then((outcome) => {
        throw new Error(
          `Producer finished before receipt observation: ${outcome.status}`,
        );
      }),
    ]);
    assert.equal(original.payload.status, "committed");
    assert.equal(version(original.payload.version), "1");
    assert.equal(
      await ctx.cluster.sql("SELECT revision FROM zooglass_runtime;"),
      "1",
    );
    ctx.record("receipt-withheld-after-commit", {
      generation: String(original.generation),
      version: "1",
    });
    await takeover(ctx, owner);
    const recovered = await result;
    if (recovered.status !== "resolved") assert.fail(recovered.reason);
    assert.equal(recovered.receipt.status, "duplicate");
    assert.deepEqual(recovered.receipt.targets, original.payload.targets);
    assert.equal(version(recovered.receipt.version), "1");
    assert.equal(producer.retained, undefined);
  } finally {
    observation.removeEventListener("abort", abort);
    producer.close();
    await result?.catch(() => {});
  }
}
export async function case5(ctx: CaseContext): Promise<void> {
  const owner = await ctx.cluster.readyOwner(),
    events: ViewerEvent[] = [],
    ownership = new Ownership();
  const viewer = new HaViewer({
    origins: ctx.cluster.nodes.map((node) => node.viewer),
    transport: transport(ctx),
    ownership,
    maxBytes,
    maxResources: 2,
    onEvent: (event) => events.push(event),
  });
  try {
    await viewer.start([resource]);
    assert.equal(
      (await publish(ctx, owner.index, input(1))).status,
      "committed",
    );
    await waitFor(
      async () =>
        events.some(
          (event) =>
            event.type === "snapshot" && version(event.value.version) === "1",
        )
          ? true
          : undefined,
      "acknowledged live state",
      ctx.signal,
    );
    const before = events.length,
      successor = await takeover(ctx, owner);
    await waitFor(
      async () =>
        ownership.generation === successor.generation &&
        events
          .slice(before)
          .some(
            (event) =>
              event.type === "snapshot" && version(event.value.version) === "1",
          )
          ? true
          : undefined,
      "fresh successor baseline",
      ctx.signal,
    );
    assert.ok(events.slice(before).some((event) => event.type === "clear"));
    assert.equal(
      version((await capture(ctx, successor.index)).payload.version),
      "1",
    );
  } finally {
    await viewer.close();
  }
}
export async function case6(ctx: CaseContext): Promise<void> {
  const owner = await ctx.cluster.readyOwner();
  await publish(ctx, owner.index, input(1));
  await ctx.cluster.nodes[owner.index].partitionDb(true);
  try {
    await ctx.pause();
    const successor = await waitFor(
      async () => {
        const value = await ctx.cluster.readyOwner();
        return value.index !== owner.index ? value : undefined;
      },
      "takeover while former listener stays reachable",
      ctx.signal,
    );
    assert.ok(successor.generation > owner.generation);
    const denied = await rawGet(
      ctx,
      ctx.cluster.nodes[owner.index].viewer,
      "/views/match/42",
    );
    assert.equal(denied.status, 503);
    assert.equal(denied.body, "");
    assert.equal(
      (await ctx.cluster.nodes[owner.index].publish(input(2))).status,
      "unresolved",
    );
    assert.equal(
      await ctx.cluster.sql("SELECT revision FROM zooglass_runtime;"),
      "1",
    );
    assert.equal(
      (await publish(ctx, successor.index, input(2))).status,
      "committed",
    );
    assert.equal(
      version((await capture(ctx, successor.index)).payload.version),
      "2",
    );
    ctx.record("isolated-former-owner-refused", {
      former: String(owner.index),
      successor: String(successor.index),
    });
  } finally {
    await ctx.cluster.nodes[owner.index].partitionDb(false);
  }
}
