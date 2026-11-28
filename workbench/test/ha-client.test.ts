import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { performance } from "node:perf_hooks";
import { Ownership } from "../src/service/ha/ownership.js";
import { HaViewer } from "../src/service/ha/viewer.js";
import { HaProducer } from "../src/service/ha/producer.js";
import {
  decode,
  IncarnationChanged,
  type Envelope,
} from "../src/service/ha/protocol.js";
import type { ViewerEvent } from "../src/service/ha/viewer-state.js";
import {
  deferred,
  incarnation,
  otherIncarnation,
  publication,
  receipt,
  resource,
  snapshot,
  TestChannel,
  TestTransport,
  viewerChannel,
  wire,
} from "./helpers/ha.js";
const origins = ["https://first.test", "https://second.test"];
function viewer(
  transport: TestTransport,
  ownership = new Ownership(),
  events: ViewerEvent[] = [],
  maxResources = 4,
) {
  return new HaViewer({
    origins,
    transport,
    ownership,
    maxBytes: 16384,
    maxResources,
    onEvent: (e) => events.push(e),
    episodeMillis: 1200,
    stepMillis: 500,
  });
}
function producer(
  transport: TestTransport,
  ownership = new Ownership(),
  bounds = { episodeMillis: 1200, stepMillis: 500 },
) {
  return new HaProducer({
    origins,
    transport,
    ownership,
    maxBytes: 16384,
    ...bounds,
  });
}
function hello(generation = "1") {
  return decode(wire("hello", {}, generation), 16384) as Envelope;
}

test("new incarnation from HTTP clears the live viewer and aborts the pending producer without losing bytes", async (t) => {
  const ownership = new Ownership(),
    events: ViewerEvent[] = [];
  const live = viewerChannel(),
    transport = new TestTransport([live]);
  const client = viewer(transport, ownership, events);
  t.after(() => client.close());
  await client.start([resource]);
  assert.equal(events.at(-1)?.type, "snapshot");
  const source = new TestChannel();
  source.push(wire("hello"));
  const sent = once(source.events, "sent");
  const writer = producer(new TestTransport([source]), ownership);
  t.after(() => writer.close());
  const result = writer.publish(publication);
  await sent;
  transport.readHandler = async () => ({
    status: 200,
    body: wire(
      "snapshot",
      { ...snapshot(), entityId: "other" },
      "1",
      "1",
      otherIncarnation,
    ),
  });
  await client.read({ viewId: "v", entityId: "other" });
  const unresolved = await result;
  assert.equal(unresolved.status, "unresolved");
  assert.equal(writer.retained?.bytes, publication);
  assert.equal(writer.retained?.incarnation, incarnation);
  assert.equal(ownership.incarnation, incarnation);
  assert.equal(ownership.signal.aborted, true);
  assert.equal(live.closed, true);
  assert.equal(events.at(-1)?.type, "clear");
  assert.throws(() => writer.publish(publication), IncarnationChanged);
});

test("new incarnation first seen by producer retires an independently live viewer", async (t) => {
  const ownership = new Ownership(),
    events: ViewerEvent[] = [];
  const live = viewerChannel();
  const client = viewer(new TestTransport([live]), ownership, events);
  t.after(() => client.close());
  await client.start([resource]);
  const source = new TestChannel();
  source.push(wire("hello", {}, "1", "1", otherIncarnation));
  const writer = producer(new TestTransport([source]), ownership);
  t.after(() => writer.close());
  assert.equal((await writer.publish(publication)).status, "unresolved");
  assert.equal(source.sent.length, 0);
  assert.equal(writer.retained?.incarnation, incarnation);
  assert.equal(writer.retained?.bytes, publication);
  assert.equal(live.closed, true);
  assert.equal(events.at(-1)?.type, "clear");
});

test("restored publication keeps its explicitly pinned old incarnation on mismatch", async () => {
  const ownership = new Ownership(incarnation),
    source = new TestChannel();
  source.push(wire("hello", {}, "1", "1", otherIncarnation));
  const writer = new HaProducer({
    origins,
    transport: new TestTransport([source]),
    ownership,
    maxBytes: 16384,
    retained: { bytes: publication, incarnation },
  });
  try {
    assert.equal((await writer.retry()).status, "unresolved");
    assert.equal(source.sent.length, 0);
    assert.equal(writer.retained?.incarnation, incarnation);
    assert.equal(ownership.signal.aborted, true);
  } finally {
    writer.close();
  }
});

test("viewer retries a stale owner hello using the other configured origin", async (t) => {
  const ownership = new Ownership();
  ownership.observe(hello("2"));
  const stale = viewerChannel("1"),
    current = viewerChannel("2"),
    transport = new TestTransport([stale, current]);
  const client = viewer(transport, ownership);
  t.after(() => client.close());
  await client.start([resource]);
  assert.deepEqual(
    transport.connections.map((c) => c.origin),
    origins,
  );
  assert.equal(stale.closed, true);
  assert.equal(current.sent.length, 1);
});

test("lost receipt retries identical bytes and resolves only the matching duplicate", async () => {
  const first = new TestChannel((_raw, self) => self.close());
  first.push(wire("hello"));
  const second = new TestChannel((_raw, self) =>
    self.push(wire("receipt", receipt("alreadyCommitted", "duplicate"), "2")),
  );
  second.push(wire("hello", {}, "2"));
  const transport = new TestTransport([first, second]),
    writer = producer(transport);
  try {
    const result = await writer.publish(publication);
    assert.equal(result.status, "resolved");
    assert.deepEqual(first.sent, [publication]);
    assert.deepEqual(second.sent, [publication]);
    assert.equal(writer.retained, undefined);
  } finally {
    writer.close();
  }
});

test("conflict receipts and mismatched identities never discard the retained publication", async () => {
  for (const mismatch of [false, true]) {
    const outcome = receipt(
      mismatch ? "postgresCommitted" : "identityConflict",
      mismatch ? "committed" : "rejected",
    );
    if (mismatch) outcome.stream.sourceId = "wrong";
    const source = new TestChannel((_raw, self) =>
      self.push(wire("receipt", outcome)),
    );
    source.push(wire("hello"));
    const writer = producer(new TestTransport([source]));
    try {
      assert.equal((await writer.publish(publication)).status, "unresolved");
      assert.equal(writer.retained?.bytes, publication);
    } finally {
      writer.close();
    }
  }
});

test(
  "receipt deadline bounds an unresponsive source and preserves one pending publication",
  { timeout: 2000 },
  async (t) => {
    let now = 0;
    t.mock.method(performance, "now", () => now);
    const source = new TestChannel();
    source.push(wire("hello"));
    const transport = new TestTransport([source]),
      writer = producer(transport, new Ownership(), {
        episodeMillis: 40,
        stepMillis: 20,
      });
    let receiptSignal: AbortSignal | undefined;
    const next = source.next.bind(source);
    t.mock.method(source, "next", (signal: AbortSignal) => {
      if (source.sent.length > 0) {
        receiptSignal = signal;
        // Exercise the real receipt timer, then exhaust the episode deterministically.
        // A real backoff timer can wake just before its deadline and permit another try.
        signal.addEventListener(
          "abort",
          () => {
            now = 40;
          },
          { once: true },
        );
      }
      return next(signal);
    });
    try {
      const pending = writer.publish(publication);
      assert.throws(
        () => writer.publish(publication),
        /unresolved publication/,
      );
      const result = await pending;
      assert.equal(result.status, "unresolved");
      assert.ok(receiptSignal?.aborted);
      assert.equal(receiptSignal.reason.name, "TimeoutError");
      assert.deepEqual(source.sent, [publication]);
      assert.equal(source.closed, true);
      assert.deepEqual(writer.retained, { bytes: publication, incarnation });
      assert.throws(
        () => writer.publish(publication),
        /unresolved publication/,
      );
    } finally {
      writer.close();
    }
  },
);

test("delayed HTTP error and reply are discarded after a live baseline takes presentation ownership", async (t) => {
  for (const fail of [false, true]) {
    const reply = deferred<{ status: number; body: string }>(),
      entered = deferred<void>();
    const transport = new TestTransport([viewerChannel()], async () => {
      entered.resolve();
      return reply.promise;
    });
    const client = viewer(transport);
    t.after(() => client.close());
    const read = client.read(resource);
    await entered.promise;
    await client.start([resource]);
    if (fail) reply.reject(new Error("old read failed"));
    else reply.resolve({ status: 404, body: wire("notFound") });
    assert.equal(await read, undefined);
    assert.equal(client.state.ready, true);
  }
});

test("rejected excess resources cannot retain HTTP operations or prevent the admitted read", async (t) => {
  const reply = deferred<{ status: number; body: string }>(),
    entered = deferred<void>();
  const transport = new TestTransport([], async () => {
    entered.resolve();
    return reply.promise;
  });
  const client = viewer(transport, new Ownership(), [], 1);
  t.after(() => client.close());
  const accepted = client.read(resource);
  await entered.promise;
  for (let i = 0; i < 50; i++)
    await assert.rejects(
      client.read({ viewId: "v", entityId: String(i) }),
      /capacity/,
    );
  // Inspect only bounded bookkeeping; transport entry count alone missed the original leak.
  assert.equal(
    (client as unknown as { http: Map<string, unknown> }).http.size,
    1,
  );
  assert.equal(transport.reads.length, 1);
  reply.resolve({ status: 200, body: wire("snapshot", snapshot()) });
  assert.ok(await accepted);
  assert.equal(
    (client as unknown as { http: Map<string, unknown> }).http.size,
    0,
  );
});

test("same-generation reconnect opens a fresh membership and ignores the retired socket", async (t) => {
  const first = viewerChannel(),
    second = viewerChannel(),
    transport = new TestTransport([first, second]);
  const secondBaseline = deferred<void>();
  let snapshots = 0;
  const client = new HaViewer({
    origins,
    transport,
    ownership: new Ownership(),
    maxBytes: 16384,
    maxResources: 2,
    episodeMillis: 1200,
    stepMillis: 500,
    onEvent: (event) => {
      if (event.type === "snapshot" && ++snapshots === 2)
        secondBaseline.resolve();
    },
  });
  t.after(() => client.close());
  await client.start([resource]);
  first.close();
  await secondBaseline.promise;
  assert.equal(transport.connections.length, 2);
  assert.equal(
    (JSON.parse(first.sent[0]) as { subscription: string }).subscription,
    "1",
  );
  assert.equal(
    (JSON.parse(second.sent[0]) as { subscription: string }).subscription,
    "1",
  );
  first.push(
    wire("update", { subscription: "1", snapshot: snapshot(99) }, "1", "99"),
  );
  assert.equal(snapshots, 2);
  assert.equal(client.state.ready, true);
});

test("a new-resource policy refusal preserves the accepted stream and permits another command", async (t) => {
  const channel = new TestChannel((raw, self) => {
    const p = JSON.parse(raw) as {
      action: string;
      subscription: string;
      viewId: string;
      entityId: string;
    };
    if (p.entityId === "denied") {
      self.push(
        JSON.stringify({ error: "accessDenied", subscription: p.subscription }),
      );
      return;
    }
    self.push(
      wire("subscribed", {
        subscription: p.subscription,
        viewId: p.viewId,
        entityId: p.entityId,
        recovery: "freshSnapshot",
      }),
    );
    self.push(
      wire("baseline", {
        subscription: p.subscription,
        snapshot: { ...snapshot(), entityId: p.entityId },
      }),
    );
  });
  channel.push(wire("hello"));
  const events: ViewerEvent[] = [],
    client = viewer(new TestTransport([channel]), new Ownership(), events, 2);
  t.after(() => client.close());
  await client.start([resource]);
  assert.equal(
    await client.subscribe({ viewId: "v", entityId: "denied" }),
    false,
  );
  assert.equal(channel.closed, false);
  assert.equal(client.state.ready, true);
  assert.equal(
    await client.subscribe({ viewId: "v", entityId: "allowed" }),
    true,
  );
  assert.equal(events.filter((e) => e.type === "snapshot").length, 2);
});

test("a receipt from a superseded generation is retried instead of resolving the publication", async () => {
  const ownership = new Ownership();
  const old = new TestChannel((_raw, self) => {
    ownership.observe(hello("2"));
    self.push(wire("receipt", receipt()));
  });
  old.push(wire("hello"));
  const current = new TestChannel((_raw, self) =>
    self.push(wire("receipt", receipt("alreadyCommitted", "duplicate"), "2")),
  );
  current.push(wire("hello", {}, "2"));
  const transport = new TestTransport([old, current]),
    writer = producer(transport, ownership);
  try {
    assert.equal((await writer.publish(publication)).status, "resolved");
    assert.equal(transport.connections.length, 2);
    assert.deepEqual(current.sent, [publication]);
  } finally {
    writer.close();
  }
});

test("an inconsistent baseline reopens a fresh subscription instead of permanently stopping", async (t) => {
  const inconsistent = new TestChannel((raw, self) => {
    const p = JSON.parse(raw) as { subscription: string };
    self.push(
      wire("subscribed", {
        ...resource,
        subscription: p.subscription,
        recovery: "freshSnapshot",
      }),
    );
    self.push(
      wire(
        "baseline",
        { subscription: p.subscription, snapshot: snapshot() },
        "1",
        "2",
      ),
    );
  });
  inconsistent.push(wire("hello"));
  const good = viewerChannel(),
    transport = new TestTransport([inconsistent, good]);
  const client = viewer(transport);
  t.after(() => client.close());
  await client.start([resource]);
  assert.equal(transport.connections.length, 2);
  assert.equal(inconsistent.closed, true);
  assert.equal(client.state.ready, true);
});

test("throwing presentation callbacks cannot interrupt cross-role invalidation", async (t) => {
  const owner = new Ownership();
  owner.listen(() => {
    throw new Error("application callback failed");
  });
  const live = viewerChannel(),
    client = viewer(new TestTransport([live]), owner);
  t.after(() => client.close());
  await client.start([resource]);
  assert.throws(() => owner.rejectIncarnation(), IncarnationChanged);
  assert.equal(live.closed, true);
  assert.equal(client.state.ready, false);
});

test("caller mutation cannot replace viewer or producer ownership and transport after construction", async (t) => {
  const owner = new Ownership(incarnation),
    other = new Ownership(otherIncarnation),
    live = viewerChannel();
  const viewerSettings = {
    origins: [...origins],
    transport: new TestTransport([live]),
    ownership: owner,
    maxBytes: 16384,
    maxResources: 2,
    onEvent: () => {},
    stepMillis: 500,
    episodeMillis: 1200,
  };
  const client = new HaViewer(viewerSettings);
  t.after(() => client.close());
  viewerSettings.transport = new TestTransport();
  viewerSettings.ownership = other;
  viewerSettings.episodeMillis = 0;
  await client.start([resource]);
  assert.equal(client.state.ready, true);
  const source = new TestChannel((_raw, self) =>
    self.push(wire("receipt", receipt())),
  );
  source.push(wire("hello"));
  const producerSettings = {
    origins: [...origins],
    transport: new TestTransport([source]),
    ownership: owner,
    maxBytes: 16384,
    stepMillis: 500,
    episodeMillis: 1200,
  };
  const writer = new HaProducer(producerSettings);
  t.after(() => writer.close());
  producerSettings.transport = new TestTransport();
  producerSettings.ownership = other;
  producerSettings.episodeMillis = 0;
  assert.equal((await writer.publish(publication)).status, "resolved");
  assert.equal(other.generation, 0n);
});

test("restoring a pinned spool rejects unpinned or differently pinned shared ownership before network work", () => {
  const retained = Object.freeze({ bytes: publication, incarnation });
  for (const owner of [new Ownership(), new Ownership(otherIncarnation)]) {
    const transport = new TestTransport();
    assert.throws(
      () =>
        new HaProducer({
          origins,
          transport,
          ownership: owner,
          maxBytes: 16384,
          retained,
        }),
      /matching Ownership incarnation pin/,
    );
    assert.equal(transport.connections.length, 0);
    assert.equal(retained.bytes, publication);
    assert.equal(retained.incarnation, incarnation);
  }
});

test("HTTP-only stale success and error retire on another role observing takeover", async (t) => {
  for (const fail of [false, true]) {
    const pending = deferred<{ status: number; body: string }>(),
      entered = deferred<void>(),
      owner = new Ownership();
    owner.observe(hello());
    const transport = new TestTransport([], async () => {
        entered.resolve();
        return pending.promise;
      }),
      client = viewer(transport, owner);
    t.after(() => client.close());
    const result = client.read(resource);
    await entered.promise;
    owner.observe(hello("2"));
    if (fail) pending.reject(new Error("obsolete failure"));
    else pending.resolve({ status: 200, body: wire("snapshot", snapshot()) });
    assert.equal(await result, undefined);
    transport.readHandler = async () => ({
      status: 200,
      body: wire("snapshot", snapshot(), "3"),
    });
    assert.ok(await client.read(resource));
    assert.equal(owner.generation, 3n);
  }
});

test("a different incarnation in a receipt invalidates the shared viewer and preserves the spool", async (t) => {
  const owner = new Ownership(),
    live = viewerChannel(),
    client = viewer(new TestTransport([live]), owner);
  t.after(() => client.close());
  await client.start([resource]);
  const source = new TestChannel((_raw, self) =>
    self.push(wire("receipt", receipt(), "8", "1", otherIncarnation)),
  );
  source.push(wire("hello"));
  const writer = producer(new TestTransport([source]), owner);
  t.after(() => writer.close());
  assert.equal((await writer.publish(publication)).status, "unresolved");
  assert.equal(owner.signal.aborted, true);
  assert.equal(live.closed, true);
  assert.equal(writer.retained?.bytes, publication);
});

test("durable success receipts need the correct reason and a positive original revision within content", async () => {
  for (const [status, reason, version] of [
    ["committed", "arbitrary", 1],
    ["committed", "postgresql", null],
    ["committed", "postgresql", 0],
    ["duplicate", "alreadyCommitted", 2],
    ["duplicate", "postgresql", 1],
  ] as const) {
    const source = new TestChannel((_raw, self) =>
      self.push(wire("receipt", { ...receipt(reason, status), version })),
    );
    source.push(wire("hello"));
    const writer = producer(new TestTransport([source]));
    try {
      assert.equal((await writer.publish(publication)).status, "unresolved");
      assert.equal(writer.retained?.bytes, publication);
    } finally {
      writer.close();
    }
  }
});

test("higher shared generation immediately cancels a pending receipt then retries original bytes", async () => {
  const owner = new Ownership(),
    first = new TestChannel();
  first.push(wire("hello"));
  const sent = once(first.events, "sent");
  const second = new TestChannel((_raw, self) =>
    self.push(wire("receipt", receipt("alreadyCommitted", "duplicate"), "2")),
  );
  second.push(wire("hello", {}, "2"));
  const writer = producer(new TestTransport([first, second]), owner);
  try {
    const result = writer.publish(publication);
    await sent;
    owner.observe(hello("2"));
    assert.equal(first.closed, true);
    assert.equal((await result).status, "resolved");
    assert.deepEqual(second.sent, [publication]);
  } finally {
    writer.close();
  }
});

test("rejected subscription capacity leaves no desired resource and resource extras never enter commands", async (t) => {
  const transport = new TestTransport([viewerChannel()]),
    client = viewer(transport, new Ownership(), [], 1);
  t.after(() => client.close());
  await client.read(resource);
  await client.start([]);
  // Starting retires HTTP presentations; occupy the single slot again without a membership.
  await client.read(resource);
  await assert.rejects(
    client.subscribe({ viewId: "v", entityId: "other" }),
    /capacity/,
  );
  assert.equal(
    (client as unknown as { desired: Map<string, unknown> }).desired.size,
    0,
  );
  const hostile = {
    ...resource,
    action: "unsubscribe",
    subscription: "999",
    payload: "must not retain",
  };
  assert.equal(await client.subscribe(hostile), true);
  const desired = [
    ...(
      client as unknown as { desired: Map<string, unknown> }
    ).desired.values(),
  ];
  assert.deepEqual(desired, [resource]);
});

test("receipt completion retired before its continuation cannot invalidate a successor incarnation pin", async () => {
  const owner = new Ownership(),
    first = new TestChannel();
  first.push(wire("hello"));
  const sent = once(first.events, "sent");
  const second = new TestChannel((_raw, self) =>
    self.push(wire("receipt", receipt("alreadyCommitted", "duplicate"), "2")),
  );
  second.push(wire("hello", {}, "2"));
  const writer = producer(new TestTransport([first, second]), owner);
  try {
    const result = writer.publish(publication);
    await sent;
    first.push(wire("receipt", receipt(), "1", "1", otherIncarnation));
    owner.observe(hello("2"));
    assert.equal((await result).status, "resolved");
    assert.equal(owner.signal.aborted, false);
    assert.equal(owner.incarnation, incarnation);
    assert.deepEqual(second.sent, [publication]);
  } finally {
    writer.close();
  }
});
