import assert from "node:assert/strict";
import https from "node:https";
import { Decimal, encodeJson, parseJson, type Json } from "../json/lossless.js";
import {
  decode,
  AccessFailure,
  object,
  mediaType,
  type ObjectValue,
} from "../service/ha/protocol.js";
import { BindingObservation } from "./binding-observation.js";
import { HaViewer } from "../service/ha/viewer.js";
import { Ownership } from "../service/ha/ownership.js";
import type { ViewerEvent } from "../service/ha/viewer-state.js";
import {
  capture,
  publish,
  publication,
  takeover,
  transport,
  waitFor,
  type CaseContext,
} from "./context.js";

export const semanticConfiguration = {
  contractVersion: 2,
  storage: "postgresql",
  maxStreams: 6,
  identityWindow: 2,
  maxHistoryEntries: 2,
  sources: [
    { id: "primary", epoch: "run" },
    { id: "backup", epoch: "run" },
  ],
  views: [
    {
      id: "position",
      fields: {
        chosen: {
          mode: "latestBySequence",
          inputs: [
            { sourceId: "backup", type: "score" },
            { sourceId: "primary", type: "score" },
          ],
          conflict: { mode: "sourcePriority", sources: ["primary", "backup"] },
        },
        label: { sourceId: "primary", type: "label", mode: "arrival" },
      },
      publication: {
        mode: "requireContributions",
        fields: ["chosen", "label"],
        maxPendingEntities: 3,
      },
    },
    {
      id: "trail",
      fields: {
        recent: { sourceId: "backup", type: "score", mode: "arrival" },
        history: {
          sourceId: "backup",
          type: "score",
          mode: "historyBySequence",
        },
      },
    },
  ],
};
function equalJson(actual: Json | undefined, expected: Json): void {
  assert.notEqual(actual, undefined);
  assert.equal(encodeJson(actual!), encodeJson(expected));
}
const trail = { viewId: "trail", entityId: "42" };
const position = { viewId: "position", entityId: "42" };
const event = (source: string, sequence: number, type: string, value: number) =>
  publication(source, sequence, type, { value });
const number = (value: Json | undefined, expected: number) =>
  equalJson(value, new Decimal(String(expected)));
const field = (snapshot: ObjectValue, name: string) =>
  object(object(snapshot.data)[name]);
function expectedValue(value: number): Json {
  return { value: new Decimal(String(value)) };
}
function expectedContribution(sequence: number, value: number): Json {
  return {
    publicationSequence: new Decimal(String(sequence)),
    payload: expectedValue(value),
  };
}
function provenance(snapshot: ObjectValue, name: string, source: string): void {
  equalJson(object(snapshot.provenance)[name], {
    sourceId: source,
    epoch: "run",
    sourceEntityId: "42",
  });
}
async function committed(
  ctx: CaseContext,
  index: number,
  bytes: string,
  version: number,
): Promise<ObjectValue> {
  const receipt = await publish(ctx, index, bytes);
  assert.equal(receipt.status, "committed");
  assert.equal(receipt.reason, "postgresql");
  number(receipt.version, version);
  return receipt;
}

export async function case9(ctx: CaseContext): Promise<void> {
  const owner = await ctx.cluster.readyOwner();
  const original = await committed(
    ctx,
    owner.index,
    event("backup", 2, "score", 19),
    1,
  );
  await committed(ctx, owner.index, event("primary", 1, "score", 7), 2);
  const pending = await capture(ctx, owner.index, position);
  equalJson(pending.payload.data, {});
  assert.equal(object(pending.payload.status).publication, "waiting");
  equalJson(object(pending.payload.status).missingRequiredFields, ["label"]);
  ctx.record("required-contribution-pending", pending.payload);
  await ctx.pause();
  const successor = await takeover(ctx, owner);
  equalJson(
    (await capture(ctx, successor.index, position)).payload,
    pending.payload,
  );
  const retry = await publish(
    ctx,
    successor.index,
    event("backup", 2, "score", 19),
  );
  assert.equal(retry.status, "duplicate");
  number(retry.version, 1);
  equalJson(retry.targets, original.targets);
  await committed(ctx, successor.index, event("primary", 2, "label", 5), 3);
  const released = await capture(ctx, successor.index, position);
  number(released.payload.version, 3);
  assert.equal(released.contentRevision, 3n);
  equalJson(field(released.payload, "chosen"), expectedValue(7));
  equalJson(field(released.payload, "label"), expectedValue(5));
  provenance(released.payload, "chosen", "primary");
  provenance(released.payload, "label", "primary");
  assert.equal(object(released.payload.status).publication, "ready");
  await committed(ctx, successor.index, event("backup", 1, "score", 9), 4);
  const history = await capture(ctx, successor.index, trail);
  number(history.payload.version, 4);
  assert.equal(history.contentRevision, 4n);
  equalJson(object(history.payload.data).history, [
    expectedValue(9),
    expectedValue(19),
  ]);
  equalJson(field(history.payload, "recent"), expectedValue(9));
  provenance(history.payload, "recent", "backup");
  provenance(history.payload, "history", "backup");
  equalJson(history.payload.publicationSequences, {
    history: [new Decimal("1"), new Decimal("2")],
    recent: [new Decimal("1")],
  });
  equalJson(released.payload.publicationSequences, {
    chosen: [new Decimal("1")],
    label: [new Decimal("2")],
  });
  ctx.record("required-priority-history-recovered", {
    released: released.payload,
    history: history.payload,
  });
  // Public selection alone cannot demonstrate that the hidden backup survived recovery.
  const image = object(
    parseJson(
      await ctx.cluster.sql("SELECT image::text FROM zooglass_runtime"),
    ),
  );
  const views = image.views;
  assert.ok(Array.isArray(views));
  const stored = views
    .map(object)
    .find(
      (view) =>
        object(view.key).viewId === "position" &&
        object(view.key).entityId === "42",
    );
  assert.ok(stored, "Recovered durable position must exist");
  const candidates = object(object(object(stored.state).candidates).chosen);
  equalJson(object(candidates.backup).value, expectedContribution(2, 19));
  equalJson(object(candidates.primary).value, expectedContribution(1, 7));
  ctx.record("hidden-source-candidates-preserved", candidates);
  const fullHistory = await publish(
    ctx,
    successor.index,
    event("backup", 3, "score", 11),
  );
  assert.equal(fullHistory.status, "rejected");
  assert.equal(fullHistory.reason, "historyLimit");
  const unchanged = await capture(ctx, successor.index, trail);
  assert.equal(unchanged.contentRevision, 4n);
  equalJson(unchanged.payload, history.payload);
}

interface Reply {
  status: number;
  body: string;
}
async function request(
  ctx: CaseContext,
  index: number,
  path: string,
  method = "GET",
  upgrade = false,
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      ctx.cluster.nodes[index].viewer + path,
      {
        method,
        ca: ctx.cluster.ca,
        rejectUnauthorized: true,
        signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(5000)]),
        headers: {
          Authorization: `Bearer ${path === "/ha/ready" ? ctx.cluster.credentials.probe : "viewer"}`,
          Origin: "https://fixture-viewer.example",
          Accept: mediaType,
          ...(upgrade
            ? {
                Connection: "Upgrade",
                Upgrade: "websocket",
                "Sec-WebSocket-Version": "13",
                "Sec-WebSocket-Key": "MDEyMzQ1Njc4OWFiY2RlZg==",
                "Sec-WebSocket-Protocol": "zooglass.ha.v1",
              }
            : {}),
        },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += String(chunk);
          if (Buffer.byteLength(body) > 65536)
            res.destroy(new Error("Reply exceeds bound"));
        });
        res.on("error", reject);
        res.on("aborted", () => reject(new Error("Incomplete reply")));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("upgrade", (_res, socket) => {
      socket.destroy();
      reject(new Error("Unsupported control unexpectedly upgraded"));
    });
    req.on("error", reject);
    req.end();
  });
}
async function refusal(
  ctx: CaseContext,
  index: number,
  status: number,
): Promise<void> {
  const reply = await request(ctx, index, "/views/trail/42");
  assert.equal(reply.status, status);
  assert.equal(
    reply.body,
    "",
    "Refusal must not leak resource data or owner metadata",
  );
}
async function durableState(ctx: CaseContext): Promise<string> {
  return ctx.cluster.sql(
    "SELECT json_build_object('revision', revision, 'image', image, 'configuration', configuration, 'incarnation', incarnation, 'tenant', tenant, 'runtimeId', runtime_id, 'profile', profile)::text FROM zooglass_runtime",
  );
}

async function reconciledRefusal(
  ctx: CaseContext,
  index: number,
  bytes: string,
  reason: string,
  expectedState: string,
): Promise<void> {
  const result = await ctx.cluster.nodes[index].publish(bytes);
  assert.equal(result.status, "unresolved");
  assert.equal(result.reason, reason);
  assert.ok(
    result.receiptJson,
    "Known reconciliation refusal must carry its real receipt",
  );
  const rejected = object(parseJson(result.receiptJson));
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.reason, reason);
  assert.equal(result.publication?.bytes, bytes);
  assert.ok(result.publication?.incarnation);
  // The application fixture verifies the refusal against durable state before explicitly reconciling it.
  assert.equal(await durableState(ctx), expectedState);
  ctx.record("retained-refusal-reconciled", {
    node: String(index),
    receipt: rejected,
    bytes,
    incarnation: result.publication.incarnation,
    durableStateUnchanged: true,
  });
  await ctx.cluster.nodes[index].discardAfterReconciliation(bytes);
}

export async function case10(ctx: CaseContext): Promise<void> {
  let owner = await ctx.cluster.readyOwner();
  const first = event("backup", 2, "score", 19);
  await committed(ctx, owner.index, first, 1);
  const retained = event("primary", 6, "unmatched", 0);
  const original = await committed(ctx, owner.index, retained, 2);
  const before = await durableState(ctx);
  const rejectInputs = [
    [event("primary", 1, "score", 7), "outsideRetention"],
    [event("primary", 6, "unmatched", 1), "identityConflict"],
  ];
  for (const [bytes, reason] of rejectInputs) {
    await reconciledRefusal(ctx, owner.index, bytes, reason, before);
  }
  assert.equal(await durableState(ctx), before);
  owner = await takeover(ctx, owner);
  for (const [bytes, reason] of rejectInputs) {
    await reconciledRefusal(ctx, owner.index, bytes, reason, before);
  }
  const duplicate = await publish(ctx, owner.index, retained);
  assert.equal(duplicate.status, "duplicate");
  number(duplicate.version, 2);
  equalJson(duplicate.targets, original.targets);
  for (const [path, method, upgrade, status] of [
    ["/views", "POST", false, 405],
    ["/progress", "GET", true, 404],
    ["/facts/retire", "GET", true, 404],
  ] as const) {
    const reply = await ctx.cluster.nodes[owner.index].operatorRequest(
      path,
      method,
      upgrade,
    );
    assert.equal(reply.status, status);
    assert.equal(reply.body, "");
  }
  const fact = JSON.stringify({
    ...JSON.parse(event("backup", 3, "score", 11)),
    fact: { birthSequence: 3, revision: 1, operation: "create" },
  });
  const factReply = await publish(ctx, owner.index, fact);
  assert.equal(factReply.status, "rejected");
  assert.equal(factReply.reason, "factsNotConfigured");
  assert.equal(await durableState(ctx), before);
  ctx.record("retention-conflict-controls-unchanged", { duplicate, factReply });
  await incompatibleBindings(ctx, owner.index, before);
}

async function incompatibleBindings(
  ctx: CaseContext,
  index: number,
  expectedState: string,
): Promise<void> {
  for (const node of ctx.cluster.nodes) await node.kill();
  const node = ctx.cluster.nodes[index];
  const changed = structuredClone(semanticConfiguration);
  changed.identityWindow = 3;
  const variants = [
    { name: "configuration", overrides: { configuration: changed } },
    { name: "tenant", overrides: { tenant: "different-tenant" } },
    { name: "schema", overrides: {} },
  ];
  const observation = await BindingObservation.open(ctx);
  try {
    for (const variant of variants) {
      await observation.expiredLease();
      const authorityBefore = await ctx.cluster.sql(
        "SELECT json_build_object('generation', generation, 'attempt', attempt, 'role', role, 'lease', lease_until)::text FROM zooglass_runtime",
      );
      if (variant.name === "schema")
        await ctx.cluster.sql("UPDATE zooglass_runtime SET schema_version=99");
      try {
        const marker = await observation.mark();
        await node.restart(variant.overrides);
        const backend = await observation.rejectedAttempt(marker);
        // A completed TLS reply is the process-start barrier; connection refusal alone is not evidence.
        const initial = await waitFor(
          () => request(ctx, index, "/ha/ready"),
          `${variant.name} mismatch process listening without readiness`,
          ctx.signal,
          30000,
        );
        assert.equal(initial.status, 503);
        assert.equal(initial.body, "");
        await ctx.pause();
        {
          const ready = await request(ctx, index, "/ha/ready");
          assert.equal(ready.status, 503);
          assert.equal(ready.body, "");
          await refusal(ctx, index, 503);
          assert.equal(await durableState(ctx), expectedState);
          assert.equal(
            await ctx.cluster.sql(
              "SELECT schema_version FROM zooglass_runtime",
            ),
            variant.name === "schema" ? "99" : "2",
          );
        }
        assert.equal(
          await ctx.cluster.sql(
            "SELECT json_build_object('generation', generation, 'attempt', attempt, 'role', role, 'lease', lease_until)::text FROM zooglass_runtime",
          ),
          authorityBefore,
        );
        ctx.record("incompatible-binding-refused", {
          binding: variant.name,
          backend,
          leaseExpired: true,
          authorityCheckedAndRolledBack: true,
        });
      } finally {
        await node.kill();
        if (variant.name === "schema")
          await ctx.cluster.sql("UPDATE zooglass_runtime SET schema_version=2");
      }
      await node.restart();
      const recovered = await ctx.cluster.readyOwner();
      assert.equal(recovered.index, index);
      const snapshot = await capture(ctx, index, trail);
      equalJson(field(snapshot.payload, "recent"), expectedValue(19));
      number(snapshot.payload.version, 1);
      assert.equal(snapshot.contentRevision, 2n);
      assert.equal(await durableState(ctx), expectedState);
      await node.kill();
    }
  } finally {
    await observation.close();
  }
}

function viewer(
  ctx: CaseContext,
  events: ViewerEvent[],
  unavailable: (error: Error) => void,
): HaViewer {
  return new HaViewer({
    origins: ctx.cluster.nodes.map((node) => node.viewer),
    transport: transport(ctx),
    ownership: new Ownership(),
    maxBytes: 65536,
    maxResources: 2,
    onEvent: (event) => events.push(event),
    onUnavailable: unavailable,
  });
}
export async function case11(ctx: CaseContext): Promise<void> {
  await ctx.cluster.policy("allow", 5000);
  const owner = await ctx.cluster.readyOwner();
  await committed(ctx, owner.index, event("backup", 2, "score", 19), 1);
  const events: ViewerEvent[] = [];
  let unavailable: Error | undefined;
  const first = viewer(ctx, events, (error) => {
    unavailable = error;
  });
  try {
    await first.start([trail]);
    assert.equal(events.filter((event) => event.type === "snapshot").length, 1);
    const decisionsBefore = (await ctx.cluster.policyState()).decisions;
    const boundary = events.length;
    await ctx.cluster.policy("deny");
    await ctx.cluster.nodes[owner.index].kill();
    await ctx.pause();
    const next = 1 - owner.index;
    await waitFor(
      async () =>
        (await request(ctx, next, "/ha/ready")).status === 200
          ? true
          : undefined,
      "successor authority while policy denies",
      ctx.signal,
    );
    await waitFor(
      async () => (unavailable ? true : undefined),
      "denied reconnect terminates reference viewer",
      ctx.signal,
    );
    assert.ok(events.slice(boundary).some((event) => event.type === "clear"));
    assert.equal(
      events.slice(boundary).filter((event) => event.type === "snapshot")
        .length,
      0,
    );
    assert.ok((await ctx.cluster.policyState()).decisions > decisionsBefore);
    await refusal(ctx, next, 403);
    await ctx.cluster.policy("unavailable");
    await refusal(ctx, next, 503);
    const unavailableEvents: ViewerEvent[] = [];
    const failed = viewer(ctx, unavailableEvents, () => {});
    // A policy outage is retryable; cancellation must discard its incomplete opening state.
    const opening = failed.start([trail]);
    void opening.catch(() => {});
    const decisions = (await ctx.cluster.policyState()).decisions;
    await waitFor(
      async () =>
        (await ctx.cluster.policyState()).decisions > decisions
          ? true
          : undefined,
      "unavailable policy decision",
      ctx.signal,
    );
    await failed.close();
    await assert.rejects(opening);
    assert.equal(
      unavailableEvents.filter((event) => event.type === "snapshot").length,
      0,
    );
    await ctx.cluster.policy("allow", 1000);
    const admittedBefore = (await ctx.cluster.policyState()).decisions;
    const channel = await transport(ctx).connect(
      ctx.cluster.nodes[next].viewer,
      "/views/live",
      ctx.signal,
    );
    try {
      const deadline = () =>
        AbortSignal.any([ctx.signal, AbortSignal.timeout(5000)]);
      const hello = decode(await channel.next(deadline()), 65536);
      assert.ok(!("error" in hello));
      assert.equal(hello.kind, "hello");
      assert.ok(hello.generation > owner.generation);
      assert.equal(hello.incarnation, owner.incarnation);
      channel.send(
        JSON.stringify({ action: "subscribe", subscription: "1", ...trail }),
      );
      const ack = decode(await channel.next(deadline()), 65536);
      const baseline = decode(await channel.next(deadline()), 65536);
      assert.ok(!("error" in ack));
      assert.equal(ack.kind, "subscribed");
      assert.ok(!("error" in baseline));
      assert.equal(baseline.kind, "baseline");
      assert.equal(ack.contentRevision, baseline.contentRevision);
      equalJson(
        field(object(baseline.payload.snapshot), "recent"),
        expectedValue(19),
      );
      assert.ok((await ctx.cluster.policyState()).decisions > admittedBefore);
      // Renewal starts normally, but its response arrives after the existing grant expires.
      const beforeRenewal = (await ctx.cluster.policyState()).decisions;
      // Bound from arming, not a possibly late observation of the pending request.
      // Neither the five-second policy timeout nor its delayed reply can cause this close.
      const armedAt = performance.now();
      const expiry = AbortSignal.any([ctx.signal, AbortSignal.timeout(2000)]);
      await ctx.cluster.policy("allow", 1000, 5000);
      const pendingRenewal = await waitFor(
        async () => {
          const state = await ctx.cluster.policyState();
          return state.decisions > beforeRenewal && state.pendingResponses > 0
            ? state
            : undefined;
        },
        "renewal awaiting delayed policy response",
        expiry,
        2000,
      );
      await assert.rejects(
        channel.next(expiry),
        (error) =>
          error instanceof AccessFailure &&
          error.message === "Socket access lost",
      );
      assert.equal(
        expiry.aborted,
        false,
        "Grant expiry must close the socket before the harness deadline",
      );
      const closeAfterMillis = Math.round(performance.now() - armedAt);
      assert.ok(closeAfterMillis < 2000);
      ctx.record("fresh-admission-and-grant-expiry", {
        pendingRenewalObserved: true,
        grantLifetimeMillis: "1000",
        policyDelayMillis: "5000",
        policyTimeoutMillis: "5000",
        closureDeadlineMillis: "2000",
        closeAfterMillis: String(closeAfterMillis),
        renewalDecisions: String(pendingRenewal.decisions - beforeRenewal),
        generation: String(hello.generation),
        baseline: baseline.payload,
      });
    } finally {
      channel.close();
      await ctx.cluster.policy("allow", 5000, 0);
    }
  } finally {
    await first.close();
  }
}

export async function case12(ctx: CaseContext): Promise<void> {
  await ctx.cluster.policy("allow", 5000);
  const owner = await ctx.cluster.readyOwner();
  const bytes = event("backup", 2, "score", 19);
  const original = await committed(ctx, owner.index, bytes, 1);
  const before = await capture(ctx, owner.index, trail);
  number(before.payload.version, 1);
  assert.equal(before.contentRevision, 1n);
  equalJson(field(before.payload, "recent"), expectedValue(19));
  equalJson(object(before.payload.data).history, [expectedValue(19)]);
  provenance(before.payload, "recent", "backup");
  provenance(before.payload, "history", "backup");

  const events: ViewerEvent[] = [];
  const client = viewer(ctx, events, () => {});
  try {
    await client.start([trail]);
    const boundary = events.length;
    await ctx.cluster.database(false);
    await ctx.pause();
    for (const [index] of ctx.cluster.nodes.entries()) {
      await waitFor(
        async () => {
          const ready = await request(ctx, index, "/ha/ready");
          return ready.status === 503 ? true : undefined;
        },
        "backend outage readiness refusal",
        ctx.signal,
      );
      await refusal(ctx, index, 503);
    }
    await waitFor(
      async () =>
        events.slice(boundary).some((event) => event.type === "clear")
          ? true
          : undefined,
      "protected state cleared after backend loss",
      ctx.signal,
    );
    assert.equal(
      events.slice(boundary).filter((event) => event.type === "snapshot")
        .length,
      0,
    );
    await client.close();
    await ctx.cluster.database(true);
    const recovered = await ctx.cluster.readyOwner();
    assert.ok(recovered.generation > owner.generation);
    assert.equal(recovered.incarnation, owner.incarnation);
    equalJson(
      (await capture(ctx, recovered.index, trail)).payload,
      before.payload,
    );
    const retry = await publish(ctx, recovered.index, bytes);
    assert.equal(retry.status, "duplicate");
    number(retry.version, 1);
    equalJson(retry.targets, original.targets);
    const candidate = 1 - recovered.index;
    await ctx.cluster.nodes[candidate].restart();
    await waitFor(
      async () =>
        (await request(ctx, candidate, "/ha/ready")).status === 503
          ? true
          : undefined,
      "restarted candidate listening without ownership",
      ctx.signal,
      30000,
    );
    await ctx.pause();
    const successor = await takeover(ctx, recovered);
    assert.equal(successor.index, candidate);
    equalJson(
      (await capture(ctx, successor.index, trail)).payload,
      before.payload,
    );
    const activeEvents: ViewerEvent[] = [];
    const active = viewer(ctx, activeEvents, () => {});
    await active.start([trail]);
    try {
      await ctx.cancel();
      assert.ok(
        ctx.signal.aborted,
        "Harness cancellation must retire its fixture lifetime",
      );
    } finally {
      await active.close();
    }
    assert.equal(activeEvents.at(-1)?.type, "clear");
    ctx.record("backend-recovery-candidate-restart-and-cancellation", {
      incarnation: successor.incarnation,
      generation: String(successor.generation),
    });
  } finally {
    await client.close();
  }
}
