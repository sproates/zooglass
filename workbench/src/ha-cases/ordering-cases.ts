import assert from "node:assert/strict";
import { Decimal } from "../json/lossless.js";
import { Ownership } from "../service/ha/ownership.js";
import { ViewerState, type ViewerEvent } from "../service/ha/viewer-state.js";
import { object } from "../service/ha/protocol.js";
import {
  type CaseContext,
  capture,
  publication,
  publish,
  resource,
  waitFor,
} from "./context.js";
import { lockedServiceBackend } from "./database-barrier.js";
import { next, rawGet, source, subscription } from "./wire.js";

const input = (sequence: number) =>
  publication("feed", sequence, "updated", { score: sequence });
export async function case7(ctx: CaseContext): Promise<void> {
  const first = await ctx.cluster.readyOwner(),
    pending = await source(ctx, first.index);
  const beforeWrite =
    await ctx.cluster.nodes[first.index].armBarrier("write-before");
  let current = first;
  try {
    pending.send(input(1));
    await ctx.cluster.nodes[first.index].waitBarrier(
      "write-before",
      beforeWrite,
    );
    await ctx.cluster.nodes[first.index].pause();
    current = await waitFor(
      async () => {
        const owner = await ctx.cluster.readyOwner();
        return owner.index !== first.index ? owner : undefined;
      },
      "takeover after pre-write pause",
      ctx.signal,
      20000,
    );
    await ctx.cluster.nodes[first.index].resume();
    assert.equal(
      await ctx.cluster.nodes[first.index].releaseBarrier(
        "write-before",
        beforeWrite,
      ),
      "resumed",
    );
    await assert.rejects(next(ctx, pending));
    assert.equal(
      await ctx.cluster.sql("SELECT revision FROM zooglass_runtime;"),
      "0",
    );
    assert.equal(
      (await publish(ctx, current.index, input(1))).status,
      "committed",
    );
  } finally {
    pending.close();
    await ctx.cluster.nodes[first.index].resume();
  }

  const viewer = await subscription(ctx, current.index),
    events: ViewerEvent[] = [];
  const ownership = new Ownership(),
    state = new ViewerState(ownership, 2, (event) => events.push(event));
  const oldToken = state.token;
  state.receive(oldToken, viewer.hello);
  state.command("subscribe", resource);
  state.receive(oldToken, viewer.subscribed);
  state.receive(oldToken, viewer.baseline);
  try {
    for (let sequence = 2; sequence <= 6; sequence++) {
      await publish(ctx, current.index, input(sequence));
      const frame = await next(ctx, viewer.channel);
      assert.equal(frame.contentRevision, BigInt(sequence));
      state.receive(oldToken, frame);
    }
    const token = await ctx.cluster.nodes[current.index].armBarrier("before");
    await publish(ctx, current.index, input(7));
    await ctx.cluster.nodes[current.index].waitBarrier("before", token);
    await publish(ctx, current.index, input(8));
    assert.equal(
      await ctx.cluster.sql("SELECT revision FROM zooglass_runtime;"),
      "8",
    );
    assert.equal(
      await ctx.cluster.nodes[current.index].releaseBarrier("before", token),
      "resumed",
    );
    const seven = await next(ctx, viewer.channel),
      eight = await next(ctx, viewer.channel);
    assert.equal(seven.kind, "update");
    assert.equal(seven.contentRevision, 7n);
    assert.ok(seven.authorityRevision >= 8n);
    state.receive(oldToken, seven);
    state.receive(oldToken, eight);
    assert.equal(eight.contentRevision, 8n);
    assert.equal((object(seven.payload.snapshot).version as Decimal).text, "7");
    ctx.record("queued-capture-keeps-revision", {
      content: String(seven.contentRevision),
      authority: String(seven.authorityRevision),
      next: String(eight.contentRevision),
    });
    const unchanged = await capture(ctx, current.index, {
      viewId: "static",
      entityId: "42",
    });
    assert.equal(unchanged.contentRevision, 8n);
    assert.equal((unchanged.payload.version as Decimal).text, "0");

    const after = await ctx.cluster.nodes[current.index].armBarrier("after");
    await publish(ctx, current.index, input(9));
    await ctx.cluster.nodes[current.index].waitBarrier("after", after);
    await ctx.cluster.nodes[current.index].pause();
    await ctx.cluster.nodes[current.index].partitionDb(true);
    const successor = await waitFor(
      async () => {
        const owner = await ctx.cluster.readyOwner();
        return owner.index !== current.index ? owner : undefined;
      },
      "successor after actual output permit",
      ctx.signal,
    );
    assert.ok(successor.generation > current.generation);
    const fresh = await capture(ctx, successor.index);
    assert.equal(fresh.contentRevision, 9n);
    assert.equal(ownership.observe(fresh), true);
    const installed = state.finishRead(state.beginRead(resource), fresh);
    assert.deepEqual(installed, fresh.payload);
    const count = events.length;
    // Start reading before resuming, so an actual late permitted frame is retained if sent.
    const delayed = next(ctx, viewer.channel).then(
      (frame) => ({ frame }),
      (error) => ({ error }),
    );
    await ctx.cluster.nodes[current.index].resume();
    await ctx.cluster.nodes[current.index].releaseBarrier("after", after);
    const result = await delayed;
    if ("frame" in result) {
      assert.equal(result.frame.generation, current.generation);
      assert.equal(result.frame.contentRevision, 9n);
      state.receive(oldToken, result.frame);
      assert.equal(events.length, count);
      ctx.record("late-permitted-frame-discarded", {
        generation: String(result.frame.generation),
        content: "9",
      });
    } else {
      assert.ok(
        result.error instanceof Error &&
          result.error.message === "Socket closed",
        "Expected retirement close, not a timeout",
      );
      ctx.record("permitted-frame-retired", {
        generation: String(current.generation),
        content: "9",
      });
    }
    assert.equal(ownership.generation, successor.generation);
    // A frame already permitted may arrive or be discarded; no new permit can succeed on the former owner.
    const refused = await rawGet(
      ctx,
      ctx.cluster.nodes[current.index].viewer,
      "/views/match/42",
    );
    assert.equal(refused.status, 503);
    ctx.record("post-permit-takeover", {
      oldGeneration: String(current.generation),
      newGeneration: String(successor.generation),
      committedRevision: "9",
    });
  } finally {
    state.close();
    viewer.channel.close();
    await ctx.cluster.nodes[current.index].resume();
    await ctx.cluster.nodes[current.index].partitionDb(false);
  }
}
export async function case8(ctx: CaseContext): Promise<void> {
  const owner = await ctx.cluster.readyOwner(),
    channel = await source(ctx, owner.index);
  const node = ctx.cluster.nodes[owner.index],
    token = await node.armBarrier("write-locked");
  try {
    channel.send(input(1));
    await node.waitBarrier("write-locked", token);
    const pid = await lockedServiceBackend(ctx, owner.index);
    await node.pause();
    await waitFor(
      async () =>
        await ctx.cluster
          .sql(
            `SELECT count(*) FROM pg_stat_activity WHERE ${pid}=ANY(pg_blocking_pids(pid));`,
          )
          .then((value) => (Number(value) > 0 ? true : undefined)),
      "candidate blocked by service transaction",
      ctx.signal,
      8000,
    );
    await waitFor(
      async () =>
        await ctx.cluster
          .sql(`SELECT count(*) FROM pg_stat_activity WHERE pid=${pid};`)
          .then((value) => (value === "0" ? true : undefined)),
      "server idle timeout terminates paused service backend",
      ctx.signal,
      12000,
    );
    const successor = await ctx.cluster.readyOwner();
    assert.notEqual(successor.index, owner.index);
    assert.ok(successor.generation > owner.generation);
    await node.resume();
    await node.releaseBarrier("write-locked", token);
    await assert.rejects(next(ctx, channel));
    const refused = await rawGet(ctx, node.viewer, "/views/match/42");
    assert.equal(refused.status, 503);
    assert.equal(refused.body, "");
    assert.equal((await capture(ctx, successor.index)).contentRevision, 0n);
    assert.equal(
      (await publish(ctx, successor.index, input(1))).status,
      "committed",
    );
    ctx.record("expired-service-lock-holder-released", {
      backend: String(pid),
      previousGeneration: String(owner.generation),
      successorGeneration: String(successor.generation),
    });
  } finally {
    channel.close();
    await node.resume();
  }
}
