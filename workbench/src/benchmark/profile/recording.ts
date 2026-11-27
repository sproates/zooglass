/** A deliberately small recording: one aggregate event with four exact method filters. */
const methods = {
  ingress: [
    "io/zooglass/runtime/EventIngress",
    "handle",
    "(Lorg/springframework/web/socket/WebSocketSession;Lorg/springframework/web/socket/TextMessage;Z)Lio/zooglass/runtime/EventIngress$Result;",
  ],
  install: [
    "io/zooglass/runtime/SqliteState",
    "install",
    "(Lio/zooglass/runtime/StateImage;)V",
  ],
  writeChanges: [
    "io/zooglass/runtime/SqliteStateRows",
    "writeChanges",
    "(Lio/zooglass/runtime/StateImage;Lio/zooglass/runtime/StateImage;)V",
  ],
  commit: ["org/sqlite/SQLiteConnection", "commit", "()V"],
} as const;
type Method = keyof typeof methods;
const names = Object.keys(methods) as Method[];
const filters = names.map((key) => {
  const [owner, name] = methods[key];
  return owner.replaceAll("/", ".") + "::" + name;
});

export const profileSettings = `<?xml version="1.0" encoding="UTF-8"?>
<configuration version="2.0" label="SQLite publication method timing">
  <event name="jdk.MethodTiming">
    <setting name="enabled">true</setting>
    <setting name="period">1 s</setting>
    <setting name="filter">${filters.join(";")}</setting>
  </event>
</configuration>
`;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a JFR JSON object");
  }
  return value as Record<string, unknown>;
}

/** Parse the zone explicitly. Date.parse alone drops sub-millisecond digits. */
function timestamp(value: unknown) {
  const match =
    typeof value === "string" &&
    /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?(Z|[+-]\d\d:\d\d)$/.exec(
      value,
    );
  if (!match) {
    throw new Error("Invalid JFR timestamp or missing timezone");
  }
  const second = Date.parse(match[1] + match[3]);
  if (!Number.isFinite(second)) {
    throw new Error("Invalid JFR timestamp");
  }
  return BigInt(second) * 1_000_000n + BigInt((match[2] ?? "").padEnd(9, "0"));
}

function epochMilliseconds(ns: bigint) {
  return Number(ns / 1_000_000n) + Number(ns % 1_000_000n) / 1e6;
}

function durationNs(value: unknown) {
  const match =
    typeof value === "string" &&
    /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)(?:\.(\d{1,9}))?S)?$/.exec(value);
  if (!match || !(match[1] || match[2] || match[3])) {
    throw new Error("Missing or invalid JFR average duration");
  }
  const seconds =
    BigInt(match[1] ?? 0) * 3600n +
    BigInt(match[2] ?? 0) * 60n +
    BigInt(match[3] ?? 0);
  return seconds * 1_000_000_000n + BigInt((match[4] ?? "").padEnd(9, "0"));
}

interface Counter {
  calls: number;
  elapsedNs: bigint;
}
interface MethodInterval {
  invocations: number;
  totalMs: number;
  meanMs: number;
}
interface Window {
  startEpochMs: number;
  endEpochMs: number;
}

function readCounter(values: Record<string, unknown>): Counter {
  const calls = values.invocations;
  if (typeof calls !== "number" || !Number.isSafeInteger(calls) || calls < 0) {
    throw new Error("Invalid JFR invocation count");
  }
  // JDK 25 emits a missing duration for loaded methods that have never run.
  if (!calls) {
    if (
      values.average !== "PT-2562047788015215H-30M-8S" &&
      durationNs(values.average) !== 0n
    ) {
      throw new Error("Nonzero JFR average with zero invocations");
    }
    return { calls, elapsedNs: 0n };
  }
  return { calls, elapsedNs: BigInt(calls) * durationNs(values.average) };
}

/** Reduce cumulative, rounded JDK 25 counters over common snapshots inside a driver window. */
export function analyseRecording(json: unknown, window: Window) {
  const { startEpochMs, endEpochMs } = window;
  if (
    !Number.isFinite(startEpochMs) ||
    !Number.isFinite(endEpochMs) ||
    endEpochMs <= startEpochMs
  ) {
    throw new Error("Invalid analysis window");
  }
  const events = record(record(json).recording).events;
  if (!Array.isArray(events)) {
    throw new Error("Missing JFR events");
  }
  const groups = new Map<bigint, Map<Method, Counter>>();
  for (const event of events) {
    if (record(event).type !== "jdk.MethodTiming") {
      throw new Error("Expected filtered jdk.MethodTiming events");
    }
    const values = record(record(event).values);
    const tick = timestamp(values.startTime);
    const epochMs = epochMilliseconds(tick);
    if (epochMs < startEpochMs || epochMs > endEpochMs) {
      continue;
    }
    const method = record(values.method);
    const owner = record(method.type).name;
    const key = names.find(
      (k) =>
        methods[k][0] === owner &&
        methods[k][1] === method.name &&
        methods[k][2] === method.descriptor,
    );
    if (!key) {
      throw new Error("Unexpected JFR method signature");
    }
    const counters = groups.get(tick) ?? new Map<Method, Counter>();
    const next = readCounter(values);
    const previous = counters.get(key);
    if (
      previous &&
      (previous.calls !== next.calls || previous.elapsedNs !== next.elapsedNs)
    ) {
      throw new Error("Conflicting JFR counters at the same timestamp");
    }
    counters.set(key, next);
    groups.set(tick, counters);
  }
  const snapshots = [...groups].sort(([a], [b]) => (a < b ? -1 : 1));
  if (
    snapshots.length < 2 ||
    snapshots.some(([, group]) => group.size !== names.length)
  ) {
    throw new Error("Need complete, common JFR snapshots for all four methods");
  }
  const [firstAt, first] = snapshots[0];
  const [lastAt, last] = snapshots[snapshots.length - 1];
  const firstMs = epochMilliseconds(firstAt);
  const lastMs = epochMilliseconds(lastAt);
  // Allow scheduling jitter around the requested one-second sampling period.
  if (firstMs - startEpochMs > 2000 || endEpochMs - lastMs > 2000) {
    throw new Error("JFR samples do not cover the requested interval");
  }
  for (let i = 1; i < snapshots.length; i++) {
    const [previousAt, previous] = snapshots[i - 1];
    const [at, current] = snapshots[i];
    if (at - previousAt > 2_000_000_000n) {
      throw new Error("Gap in periodic JFR snapshots");
    }
    for (const key of names) {
      const a = previous.get(key)!;
      const b = current.get(key)!;
      if (
        b.calls < a.calls ||
        b.elapsedNs < a.elapsedNs ||
        (b.calls === a.calls && b.elapsedNs !== a.elapsedNs)
      ) {
        throw new Error(
          "Reset or inconsistent cumulative JFR counters for " + key,
        );
      }
    }
  }
  const intervals = {} as Record<Method, MethodInterval>;
  for (const key of names) {
    const a = first.get(key)!;
    const b = last.get(key)!;
    const invocations = b.calls - a.calls;
    const elapsedNs = b.elapsedNs - a.elapsedNs;
    if (
      !invocations ||
      elapsedNs <= 0n ||
      elapsedNs > BigInt(Number.MAX_SAFE_INTEGER)
    ) {
      throw new Error("Invalid bounded JFR interval for " + key);
    }
    const totalMs = Number(elapsedNs) / 1e6;
    intervals[key] = { invocations, totalMs, meanMs: totalMs / invocations };
  }
  return {
    startEpochMs: firstMs,
    endEpochMs: lastMs,
    spanMs: Number(lastAt - firstAt) / 1e6,
    snapshots: snapshots.length,
    methods: intervals,
  };
}
