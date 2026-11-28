import assert from "node:assert/strict";
import { Decimal, encodeJson } from "../json/lossless.js";
import { Ownership } from "../service/ha/ownership.js";
import {
  AccessFailure,
  decode,
  object,
  type Envelope,
  type ObjectValue,
} from "../service/ha/protocol.js";
import {
  NodeTransport,
  type HttpReply,
  type Transport,
} from "../service/ha/transport.js";
import { HaViewer } from "../service/ha/viewer.js";
import type { ViewerEvent } from "../service/ha/viewer-state.js";
import {
  type CaseContext,
  maxBytes,
  publication,
  publish,
  resource,
  takeover,
  waitFor,
} from "./context.js";
import { next, rawGet, signal } from "./wire.js";
import { probeRefusalObserved } from "../ha-fixture/proxy-health.js";

class DelayedHttp implements Transport {
  private held?: { reply: HttpReply; resolve: (reply: HttpReply) => void };
  armed = false;
  constructor(private readonly wire: NodeTransport) {}
  connect: Transport["connect"] = (...args) => this.wire.connect(...args);
  async read(...args: Parameters<Transport["read"]>): Promise<HttpReply> {
    const reply = await this.wire.read(...args);
    if (!this.armed) return reply;
    this.armed = false;
    return new Promise((resolve) => {
      this.held = { reply, resolve };
    });
  }
  get waiting(): boolean {
    return this.held !== undefined;
  }
  release(): void {
    const held = this.held;
    this.held = undefined;
    held?.resolve(held.reply);
  }
}
function proxyTransport(ctx: CaseContext): NodeTransport {
  return new NodeTransport({
    origins: [ctx.cluster.proxy.origin],
    ca: ctx.cluster.ca,
    bearer: "viewer",
    originHeader:
      ctx.cluster.mode === "applicationPolicy"
        ? "https://fixture-viewer.example"
        : undefined,
    maxBytes,
  });
}
function snapshotVersion(event: ViewerEvent): string | undefined {
  return event.type === "snapshot"
    ? (event.value.version as Decimal).text
    : undefined;
}
function assertScore(snapshot: ObjectValue, score: number): void {
  assert.equal(snapshot.viewId, "match");
  assert.equal(snapshot.entityId, "42");
  assert.deepEqual(snapshot.version, new Decimal(String(score)));
  assert.equal(
    encodeJson(snapshot.data),
    encodeJson({
      score: { score: new Decimal(String(score)) },
    }),
  );
  assert.equal(
    encodeJson(snapshot.provenance),
    encodeJson({
      score: { sourceId: "feed", epoch: "run", sourceEntityId: "42" },
    }),
  );
  assert.equal(
    encodeJson(snapshot.publicationSequences),
    encodeJson({
      score: [new Decimal(String(score))],
    }),
  );
}
function snapshotAt(
  events: ViewerEvent[],
  version: string,
): ObjectValue | undefined {
  const event = events.find((event) => snapshotVersion(event) === version);
  return event?.type === "snapshot" ? event.value : undefined;
}
async function proxySnapshot(ctx: CaseContext): Promise<Envelope> {
  return waitFor(
    async () => {
      const reply = await rawGet(
        ctx,
        ctx.cluster.proxy.origin,
        "/views/match/42",
      );
      if (reply.status !== 200) return undefined;
      const frame = decode(reply.body, maxBytes);
      return !("error" in frame) && frame.kind === "snapshot"
        ? frame
        : undefined;
    },
    "trusted proxy snapshot",
    ctx.signal,
    20000,
  );
}
async function stableTakeover(ctx: CaseContext): Promise<void> {
  await ctx.cluster.policy("allow", 5000);
  const owner = await ctx.cluster.readyOwner(),
    ownership = new Ownership(),
    wire = proxyTransport(ctx),
    held = new DelayedHttp(wire),
    events: ViewerEvent[] = [];
  await waitFor(
    async () =>
      await rawGet(ctx, ctx.cluster.proxy.origin, "/views/match/42").then(
        (reply) => (reply.status === 200 ? true : undefined),
      ),
    "serving proxy backend",
    ctx.signal,
  );
  const viewer = new HaViewer({
    origins: [ctx.cluster.proxy.origin],
    transport: held,
    ownership,
    maxBytes,
    maxResources: 2,
    onEvent: (event) => events.push(event),
  });
  const tap = await wire.connect(
    ctx.cluster.proxy.origin,
    "/views/live",
    signal(ctx),
  );
  let oldFrame: Envelope | undefined;
  try {
    await viewer.start([resource]);
    assert.equal((await next(ctx, tap)).kind, "hello");
    tap.send(
      JSON.stringify({ action: "subscribe", subscription: "1", ...resource }),
    );
    assert.equal((await next(ctx, tap)).kind, "subscribed");
    assert.equal((await next(ctx, tap)).kind, "baseline");
    const bytes = publication("feed", 1, "updated", { score: 1 }),
      original = await publish(ctx, owner.index, bytes);
    oldFrame = await next(ctx, tap);
    assert.equal(oldFrame.kind, "update");
    assertScore(object(oldFrame.payload.snapshot), 1);
    assertScore(
      await waitFor(
        async () => snapshotAt(events, "1"),
        "proxy update before fault",
        ctx.signal,
      ),
      1,
    );
    held.armed = true;
    const staleRead = viewer.read(resource);
    await waitFor(
      async () => (held.waiting ? true : undefined),
      "actual HTTP body retained before client callback",
      ctx.signal,
    );
    const oldToken = viewer.state.token,
      before = events.length,
      policyBefore = await ctx.cluster.policyState();
    const faultStarted = performance.now();
    const successor = await takeover(ctx, owner);
    assertScore(
      await waitFor(
        async () =>
          ownership.generation === successor.generation
            ? snapshotAt(events.slice(before), "1")
            : undefined,
        "same-origin successor baseline",
        ctx.signal,
        20000,
      ),
      1,
    );
    const baselineMillis = Math.round(performance.now() - faultStarted);
    const afterBaseline = events.length;
    held.release();
    assert.equal(await staleRead, undefined);
    viewer.state.receive(oldToken, oldFrame);
    assert.equal(events.length, afterBaseline);
    assert.ok(events.slice(before).some((event) => event.type === "clear"));
    const duplicate = await publish(ctx, successor.index, bytes);
    assert.equal(duplicate.status, "duplicate");
    assert.deepEqual(duplicate.targets, original.targets);
    assert.equal((duplicate.version as Decimal).text, "1");
    await publish(
      ctx,
      successor.index,
      publication("feed", 2, "updated", { score: 2 }),
    );
    assertScore(
      await waitFor(
        async () => snapshotAt(events, "2"),
        "continued stable-origin update",
        ctx.signal,
      ),
      2,
    );
    ctx.record("stable-origin-failover", {
      elapsedMillis: String(baselineMillis),
      timingBoundary:
        "termination-request-to-harness-confirmed-client-baseline",
      from: String(owner.index),
      to: String(successor.index),
      generation: String(successor.generation),
      oldCallbacksRejected: true,
    });
    const policyAfter = await ctx.cluster.policyState();
    // In protected mode the fixture's recorded real HTTPS decisions increase across reconnect.
    if (policyBefore.decisions > 0)
      assert.ok(policyAfter.decisions > policyBefore.decisions);
  } finally {
    held.release();
    tap.close();
    await viewer.close();
  }
}
export async function case13(ctx: CaseContext): Promise<void> {
  await stableTakeover(ctx);
}
export async function case14(ctx: CaseContext): Promise<void> {
  await stableTakeover(ctx);
  let owner = await ctx.cluster.readyOwner();
  // Restore the terminated candidate before the separate stale-health takeover.
  await ctx.cluster.nodes[1 - owner.index].restart();
  await waitFor(
    async () =>
      await rawGet(
        ctx,
        ctx.cluster.nodes[1 - owner.index].viewer,
        "/ha/ready",
        ctx.cluster.credentials.probe,
      ).then((reply) => (reply.status === 503 ? true : undefined)),
    "standby listener restored",
    ctx.signal,
  );
  await ctx.cluster.proxy.pinHealth(ctx.cluster.nodes[owner.index].name);
  await ctx.cluster.nodes[owner.index].partitionDb(true);
  try {
    const successor = await waitFor(
      async () => {
        const value = await ctx.cluster.readyOwner();
        return value.index !== owner.index ? value : undefined;
      },
      "successor despite stale proxy health",
      ctx.signal,
    );
    const stale = await rawGet(
      ctx,
      ctx.cluster.proxy.origin,
      "/views/match/42",
    );
    assert.equal(stale.status, 503);
    assert.equal(stale.body, "");
    ctx.record("stale-proxy-routing-refused", {
      former: String(owner.index),
      successor: String(successor.index),
    });
  } finally {
    await ctx.cluster.nodes[owner.index].partitionDb(false);
    await ctx.cluster.proxy.pinHealth(undefined);
  }
  owner = await ctx.cluster.readyOwner();
  await waitFor(
    async () =>
      await rawGet(ctx, ctx.cluster.proxy.origin, "/views/match/42").then(
        (reply) => (reply.status === 200 ? true : undefined),
      ),
    "proxy health catches up",
    ctx.signal,
  );
  await ctx.cluster.policy("allow", 1000);
  const wire = proxyTransport(ctx),
    channel = await wire.connect(
      ctx.cluster.proxy.origin,
      "/views/live",
      signal(ctx),
    );
  try {
    assert.equal((await next(ctx, channel)).kind, "hello");
    channel.send(
      JSON.stringify({ action: "subscribe", subscription: "1", ...resource }),
    );
    assert.equal((await next(ctx, channel)).kind, "subscribed");
    const baseline = await next(ctx, channel);
    assert.equal(baseline.kind, "baseline");
    assertScore(object(baseline.payload.snapshot), 2);
    await ctx.cluster.policy("deny");
    const denied = await rawGet(
      ctx,
      ctx.cluster.proxy.origin,
      "/views/match/42",
    );
    assert.equal(denied.status, 403);
    assert.equal(denied.body, "");
    const expiry = signal(ctx);
    await assert.rejects(
      channel.next(expiry),
      (error) =>
        error instanceof AccessFailure &&
        error.message === "Socket access lost",
    );
    assert.equal(
      expiry.aborted,
      false,
      "Denied renewal must close before the harness deadline",
    );
    const receipt = await publish(
      ctx,
      owner.index,
      publication("feed", 3, "updated", { score: 3 }),
    );
    assert.equal(receipt.status, "committed");
    await assert.rejects(channel.next(signal(ctx)), AccessFailure);
  } finally {
    channel.close();
    await ctx.cluster.policy("allow", 5000);
  }
  for (const options of [
    { token: "incorrect-probe-token" },
    { verifyHost: "wrong.invalid" },
  ]) {
    await ctx.cluster.proxy.configureProbe(options);
    const kind = "token" in options ? "credential" : "certificate-hostname";
    const health = await waitFor(
      async () => {
        const observed = await ctx.cluster.proxy.health();
        return probeRefusalObserved(observed, kind) ? observed : undefined;
      },
      "completed failed proxy probes on both backends",
      ctx.signal,
    );
    // Health removes backends for new TCP connections, not existing passthrough tunnels.
    await assert.rejects(
      rawGet(ctx, ctx.cluster.proxy.origin, "/views/match/42"),
    );
    ctx.record("invalid-proxy-probe-refused", {
      kind,
      health: health.map((row) => ({ ...row })),
    });
  }
  await ctx.cluster.proxy.configureProbe();
  assertScore((await proxySnapshot(ctx)).payload, 3);
  const untrusted = new NodeTransport({
    origins: [ctx.cluster.proxy.origin],
    maxBytes,
  });
  await assert.rejects(
    untrusted.read(ctx.cluster.proxy.origin, "/views/match/42", signal(ctx)),
    (error) =>
      error instanceof AccessFailure &&
      error.message === "TLS verification failed",
  );
  await ctx.cluster.database(false);
  try {
    await assert.rejects(
      proxyTransport(ctx).read(
        ctx.cluster.proxy.origin,
        "/views/match/42",
        signal(ctx),
      ),
    );
  } finally {
    await ctx.cluster.database(true);
  }
  const recovered = await ctx.cluster.readyOwner();
  const result = await proxySnapshot(ctx);
  assertScore(result.payload, 3);
  assert.equal(result.incarnation, recovered.incarnation);
}
