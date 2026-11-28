import assert from "node:assert/strict";
import test from "node:test";
import {
  decode,
  IncarnationChanged,
  ProtocolFailure,
  OrderingFailure,
  type Envelope,
} from "../src/service/ha/protocol.js";
import { Ownership } from "../src/service/ha/ownership.js";
import {
  ViewerState,
  type ViewerEvent,
} from "../src/service/ha/viewer-state.js";
import { Decimal } from "../src/json/lossless.js";
import {
  incarnation,
  otherIncarnation,
  resource,
  snapshot,
  wire,
  receipt,
} from "./helpers/ha.js";
function frame(
  kind: string,
  payload: unknown = {},
  generation = "1",
  revision = "1",
  pin = incarnation,
): Envelope {
  const value = decode(wire(kind, payload, generation, revision, pin), 16384);
  assert.ok(!("error" in value));
  return value;
}
function opening(state: ViewerState, id = "1", revision = "1") {
  state.receive(
    state.token,
    frame(
      "subscribed",
      { ...resource, subscription: id, recovery: "freshSnapshot" },
      "1",
      revision,
    ),
  );
  state.receive(
    state.token,
    frame(
      "baseline",
      { subscription: id, snapshot: snapshot() },
      "1",
      revision,
    ),
  );
}
test("protocol rejects duplicates, unknown members, lossy counters and unsupported payloads", () => {
  for (const raw of [
    wire("hello").replace('"kind":"hello"', '"kind":"hello","kind":"hello"'),
    wire("hello").replace('"payload":{}', '"extra":1,"payload":{}'),
    wire("hello", {}, "01"),
    wire("hello", {}, "9223372036854775808"),
    wire("unknown"),
    wire("hello", { extra: true }),
    wire("hello", { "": 0 }),
    wire("baseline", { subscription: "1", snapshot: { bad: true } }),
    wire("hello").replace('"authorityRevision":"1"', '"authorityRevision":"0"'),
  ])
    assert.throws(() => decode(raw, 16384), ProtocolFailure);
  assert.throws(() => decode(wire("hello"), 2), ProtocolFailure);
  assert.throws(
    () => decode('{"error":"accessDenied","subscription":"01"}', 16384),
    ProtocolFailure,
  );
});
test("numeric snapshot and original receipt versions retain exact long values", () => {
  const raw = wire("snapshot", snapshot(), "9223372036854775807").replace(
    '"version":1',
    '"version":9007199254740993',
  );
  const result = decode(raw, 16384) as Envelope;
  assert.equal(result.generation, 9223372036854775807n);
  assert.equal((result.payload.version as Decimal).text, "9007199254740993");
  const original = decode(
    wire("receipt", receipt()).replace(
      '"version":1',
      '"version":9223372036854775807',
    ),
    16384,
  ) as Envelope;
  assert.equal(
    (original.payload.version as Decimal).text,
    "9223372036854775807",
  );
});
test("ownership rejects former generations and latches incarnation change without repinning", () => {
  const owner = new Ownership();
  let changes = 0;
  owner.listen(() => changes++);
  assert.equal(owner.observe(frame("hello", {}, "2")), true);
  assert.equal(owner.observe(frame("hello", {}, "1")), false);
  assert.equal(owner.generation, 2n);
  assert.equal(changes, 1);
  assert.throws(
    () => owner.observe(frame("hello", {}, "1", "1", otherIncarnation)),
    IncarnationChanged,
  );
  assert.equal(owner.incarnation, incarnation);
  assert.equal(owner.signal.aborted, true);
  assert.equal(changes, 2);
  assert.throws(
    () => owner.observe(frame("hello", {}, "3")),
    IncarnationChanged,
  );
});
test("baseline must match acknowledgement, updates remain ordered, unsubscribe rejects late membership frames", () => {
  const events: ViewerEvent[] = [];
  const state = new ViewerState(new Ownership(), 2, (e) => events.push(e));
  state.receive(state.token, frame("hello"));
  state.command("subscribe", resource);
  state.receive(
    state.token,
    frame("subscribed", {
      ...resource,
      subscription: "1",
      recovery: "freshSnapshot",
    }),
  );
  assert.throws(
    () =>
      state.receive(
        state.token,
        frame(
          "baseline",
          { subscription: "1", snapshot: snapshot() },
          "1",
          "2",
        ),
      ),
    OrderingFailure,
  );
  state.receive(
    state.token,
    frame("baseline", { subscription: "1", snapshot: snapshot() }),
  );
  state.receive(
    state.token,
    frame("update", { subscription: "1", snapshot: snapshot(4) }, "1", "3"),
  );
  assert.throws(
    () =>
      state.receive(
        state.token,
        frame("update", { subscription: "1", snapshot: snapshot(2) }, "1", "2"),
      ),
    OrderingFailure,
  );
  state.command("unsubscribe", resource);
  state.receive(
    state.token,
    frame("unsubscribed", { ...resource, subscription: "1" }, "1", "3"),
  );
  const count = events.length;
  state.receive(
    state.token,
    frame("update", { subscription: "1", snapshot: snapshot(9) }, "1", "4"),
  );
  assert.equal(events.length, count);
  state.close();
});
test("delayed HTTP snapshots and 404 cannot overwrite a baseline or a newer HTTP read", () => {
  const state = new ViewerState(new Ownership(), 2, () => {});
  const old = state.beginRead(resource),
    latest = state.beginRead(resource);
  assert.equal(state.finishRead(old, frame("notFound")), undefined);
  assert.ok(state.finishRead(latest, frame("snapshot", snapshot())));
  const pending = state.beginRead(resource);
  state.receive(state.token, frame("hello"));
  state.command("subscribe", resource);
  opening(state);
  assert.equal(state.finishRead(pending, frame("notFound")), undefined);
  const live = state.beginRead(resource);
  assert.equal(
    state.finishRead(live, frame("snapshot", snapshot(99))),
    undefined,
  );
  state.close();
});
test("same-generation reconnect and cross-role generation changes retire old callbacks", () => {
  const owner = new Ownership(),
    events: ViewerEvent[] = [];
  const state = new ViewerState(owner, 2, (e) => events.push(e));
  state.receive(state.token, frame("hello"));
  const old = state.token;
  state.retire();
  state.receive(state.token, frame("hello"));
  state.receive(old, frame("hello", {}, "9"));
  assert.equal(owner.generation, 1n);
  owner.observe(frame("hello", {}, "2"));
  assert.equal(state.ready, false);
  const clears = events.filter((e) => e.type === "clear").length;
  assert.throws(
    () => owner.observe(frame("hello", {}, "1", "1", otherIncarnation)),
    IncarnationChanged,
  );
  assert.ok(events.filter((e) => e.type === "clear").length > clears);
  state.close();
});
test("refused new resource leaves existing membership live and command progress intact", () => {
  const state = new ViewerState(new Ownership(), 2, () => {});
  state.receive(state.token, frame("hello"));
  state.command("subscribe", resource);
  opening(state);
  state.command("subscribe", { viewId: "v", entityId: "other" });
  state.receive(state.token, { error: "accessDenied", subscription: "2" });
  assert.equal(state.commandPending, false);
  assert.doesNotThrow(() =>
    state.receive(
      state.token,
      frame("update", { subscription: "1", snapshot: snapshot(4) }, "1", "2"),
    ),
  );
  state.close();
});

test("persisted incarnation pins must be canonical UUID text", () => {
  for (const invalid of [
    "",
    "not-a-uuid",
    "ABCDEF00-1111-4111-8111-111111111111",
  ])
    assert.throws(() => new Ownership(invalid), ProtocolFailure);
  assert.equal(new Ownership(incarnation).incarnation, incarnation);
});

test("unknown unsubscribe reserves no slot and resource extras cannot override command identity", () => {
  const state = new ViewerState(new Ownership(), 1, () => {});
  state.receive(state.token, frame("hello"));
  assert.throws(
    () => state.command("unsubscribe", { viewId: "v", entityId: "unknown" }),
    /No live membership/,
  );
  const hostile = {
    ...resource,
    action: "unsubscribe",
    subscription: "999",
    payload: "extra",
  };
  assert.deepEqual(JSON.parse(state.command("subscribe", hostile)), {
    action: "subscribe",
    subscription: "1",
    ...resource,
  });
  state.close();
});

test("current socket different-incarnation frame invalidates ownership even with a different generation", () => {
  const owner = new Ownership(),
    state = new ViewerState(owner, 1, () => {});
  state.receive(state.token, frame("hello"));
  assert.throws(
    () =>
      state.receive(
        state.token,
        frame(
          "update",
          { subscription: "1", snapshot: snapshot() },
          "9",
          "1",
          otherIncarnation,
        ),
      ),
    IncarnationChanged,
  );
  assert.equal(owner.signal.aborted, true);
  assert.equal(state.ready, false);
  state.close();
});
