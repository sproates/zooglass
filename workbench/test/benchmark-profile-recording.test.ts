import assert from "node:assert/strict";
import test from "node:test";
import {
  analyseRecording,
  profileSettings,
} from "../src/benchmark/profile/recording.js";

// These descriptors and field units come from a real JDK 25 SQLite service recording.
const methods = [
  [
    "io/zooglass/runtime/EventIngress",
    "handle",
    "(Lorg/springframework/web/socket/WebSocketSession;Lorg/springframework/web/socket/TextMessage;Z)Lio/zooglass/runtime/EventIngress$Result;",
  ],
  [
    "io/zooglass/runtime/SqliteState",
    "install",
    "(Lio/zooglass/runtime/StateImage;)V",
  ],
  [
    "io/zooglass/runtime/SqliteStateRows",
    "writeChanges",
    "(Lio/zooglass/runtime/StateImage;Lio/zooglass/runtime/StateImage;)V",
  ],
  ["org/sqlite/SQLiteConnection", "commit", "()V"],
];
const origin = Date.parse("2026-11-27T21:08:00Z");
const window = { startEpochMs: origin + 100, endEpochMs: origin + 3100 };
function tick(second: number, count: number, average: string) {
  return methods.map(([owner, name, descriptor]) => ({
    type: "jdk.MethodTiming",
    values: {
      startTime: `2026-11-27T22:08:0${second}.123456789+01:00`,
      method: { type: { name: owner }, name, descriptor },
      invocations: count,
      average,
    },
  }));
}
function fixture() {
  return [
    ...tick(0, 100, "PT0.001S"),
    ...tick(1, 110, "PT0.0011S"),
    ...tick(2, 120, "PT0.0012S"),
  ];
}
type Events = ReturnType<typeof fixture>;
const wrap = (events: Events) => ({ recording: { events } });

test("JFC enables only the four measured methods and one-second aggregate events", () => {
  assert.equal((profileSettings.match(/<event /g) ?? []).length, 1);
  assert.match(profileSettings, /name="jdk\.MethodTiming"/);
  assert.match(profileSettings, /<setting name="period">1 s<\/setting>/);
  const filters = profileSettings.match(/name="filter">([^<]+)/)![1].split(";");
  assert.deepEqual(
    filters,
    methods.map(([owner, name]) => owner.replaceAll("/", ".") + "::" + name),
  );
});

test("differences cumulative weighted averages over actual shared timestamps", () => {
  const events = fixture();
  // An identical periodic/chunk event is idempotent. File order may differ from timestamp order.
  const result = analyseRecording(
    wrap([...events, events[4]].reverse()),
    window,
  );
  assert.equal(result.snapshots, 3);
  assert.equal(result.spanMs, 2000);
  assert.ok(Math.abs(result.startEpochMs - (origin + 123.456789)) < 0.001);
  assert.ok(Math.abs(result.endEpochMs - (origin + 2123.456789)) < 0.001);
  assert.deepEqual(result.methods.commit, {
    invocations: 20,
    totalMs: 44,
    meanMs: 2.2,
  });
});

test("ignores unrelated startup ticks and accepts JDK's zero-count missing average", () => {
  const rows = [
    ...tick(0, 0, "PT-2562047788015215H-30M-8S"),
    ...tick(1, 3, "PT0.000123456S"),
  ];
  const outside = tick(5, 0, "PT-2562047788015215H-30M-8S")[0];
  const result = analyseRecording(wrap([outside, ...rows]), {
    startEpochMs: origin,
    endEpochMs: origin + 2000,
  });
  assert.equal(result.methods.commit.totalMs, 0.370368);
});

test("rejects incomplete signatures, conflicting duplicates, gaps and counter resets within the interval", () => {
  const rejection = (edit: (e: Events) => void, message: RegExp) => {
    const e = fixture();
    edit(e);
    assert.throws(() => analyseRecording(wrap(e), window), message);
  };
  rejection((e) => {
    e.splice(5, 1);
  }, /complete, common/);
  rejection((e) => {
    e[5].values.method.descriptor = "()I";
  }, /signature/);
  rejection((e) => {
    e.push({ ...e[3], values: { ...e[3].values, invocations: 98 } });
  }, /Conflicting/);
  rejection((e) => {
    e[5].values.invocations = 99;
  }, /Reset/);
  rejection((e) => {
    e[5].values.average = "PT0.00001S";
  }, /Reset/);
  rejection((e) => {
    e[4].values.startTime = "2026-11-27T21:08:01";
  }, /timestamp/);
  rejection((e) => {
    e[2].values.average = "PT-2562047788015215H-30M-8S";
  }, /duration/);
  assert.throws(
    () =>
      analyseRecording(wrap(fixture()), {
        startEpochMs: origin,
        endEpochMs: origin + 5000,
      }),
    /cover/,
  );
  assert.throws(
    () =>
      analyseRecording(
        wrap([...tick(0, 1, "PT0.001S"), ...tick(3, 2, "PT0.001S")]),
        { startEpochMs: origin, endEpochMs: origin + 4000 },
      ),
    /Gap/,
  );
  assert.throws(
    () =>
      analyseRecording(
        wrap([...tick(0, 2, "PT0.001S"), ...tick(1, 2, "PT0.001S")]),
        { startEpochMs: origin, endEpochMs: origin + 2000 },
      ),
    /Invalid bounded/,
  );
});
