/** Authored fleet inputs and independent outcomes. No runtime imports or reconciliation.
 * Run with `node --import tsx scenarios/timeline-fleet/author.ts` from workbench.
 * Rows name exact values, versions, floors and emitted frames; helpers only serialize.
 */
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const vehicle = "vehicle-feed";
const operations = "operations-feed";
const fleet = "fleet-state";
const journey = "received-journey";
export const viewer = "fleet-viewer";
const position = (sequence: number, latitude: number, longitude: number) => ({
  sequence,
  latitude,
  longitude,
});
const operation = (sequence: number, status: string) => ({ sequence, status });
export const values = {
  p17a: position(40, 36.1408, -5.3536),
  p28a: position(40, 36.1432, -5.3544),
  p39a: position(40, 36.1387, -5.3528),
  o17a: operation(100, "available"),
  o28a: operation(100, "on-a-job"),
  o39a: operation(100, "returning"),
  p17c: position(42, 36.1412, -5.3532),
  o28c: operation(102, "available"),
  p17b: position(41, 36.141, -5.3534),
  o28b: operation(101, "returning"),
  p17conflict: position(42, 36.15, -5.36),
  o28conflict: operation(102, "returning"),
  p39b: position(41, 36.1389, -5.3526),
  o39b: operation(101, "available"),
};
type Value = keyof typeof values;
type Event = {
  at: number;
  entity: string;
  source: string;
  value: Value;
  sequence: number;
  status: string;
  version: number;
  changed: string[];
  targets: [string, string, boolean][];
};
const f = (field: string, changed = true): [string, string, boolean] => [
  fleet,
  field,
  changed,
];
const j: [string, string, boolean] = [journey, "positions", true];
// Explicit receipt oracle, including original duplicate targets/versions and current conflict versions.
export const events: Event[] = [
  {
    at: 60,
    entity: "car-17",
    source: vehicle,
    value: "p17a",
    sequence: 40,
    status: "applied",
    version: 1,
    changed: [fleet, journey],
    targets: [f("position"), j],
  },
  {
    at: 70,
    entity: "car-28",
    source: vehicle,
    value: "p28a",
    sequence: 40,
    status: "applied",
    version: 2,
    changed: [fleet, journey],
    targets: [f("position"), j],
  },
  {
    at: 80,
    entity: "car-39",
    source: vehicle,
    value: "p39a",
    sequence: 40,
    status: "applied",
    version: 3,
    changed: [fleet, journey],
    targets: [f("position"), j],
  },
  {
    at: 90,
    entity: "car-17",
    source: operations,
    value: "o17a",
    sequence: 100,
    status: "applied",
    version: 4,
    changed: [fleet],
    targets: [f("operation")],
  },
  {
    at: 100,
    entity: "car-28",
    source: operations,
    value: "o28a",
    sequence: 100,
    status: "applied",
    version: 5,
    changed: [fleet],
    targets: [f("operation")],
  },
  {
    at: 110,
    entity: "car-39",
    source: operations,
    value: "o39a",
    sequence: 100,
    status: "applied",
    version: 6,
    changed: [fleet],
    targets: [f("operation")],
  },
  {
    at: 180,
    entity: "car-17",
    source: vehicle,
    value: "p17c",
    sequence: 42,
    status: "applied",
    version: 7,
    changed: [fleet, journey],
    targets: [f("position"), j],
  },
  {
    at: 190,
    entity: "car-28",
    source: operations,
    value: "o28c",
    sequence: 102,
    status: "applied",
    version: 8,
    changed: [fleet],
    targets: [f("operation")],
  },
  {
    at: 240,
    entity: "car-17",
    source: vehicle,
    value: "p17b",
    sequence: 41,
    status: "applied",
    version: 9,
    changed: [journey],
    targets: [f("position", false), j],
  },
  {
    at: 250,
    entity: "car-28",
    source: operations,
    value: "o28b",
    sequence: 101,
    status: "applied",
    version: 10,
    changed: [],
    targets: [f("operation", false)],
  },
  {
    at: 270,
    entity: "car-17",
    source: vehicle,
    value: "p17b",
    sequence: 41,
    status: "duplicate",
    version: 9,
    changed: [],
    targets: [f("position", false), j],
  },
  {
    at: 280,
    entity: "car-17",
    source: vehicle,
    value: "p17conflict",
    sequence: 42,
    status: "rejected",
    version: 10,
    changed: [],
    targets: [],
  },
  {
    at: 290,
    entity: "car-28",
    source: operations,
    value: "o28c",
    sequence: 102,
    status: "duplicate",
    version: 8,
    changed: [],
    targets: [f("operation")],
  },
  {
    at: 300,
    entity: "car-28",
    source: operations,
    value: "o28conflict",
    sequence: 102,
    status: "rejected",
    version: 10,
    changed: [],
    targets: [],
  },
  {
    at: 310,
    entity: "car-39",
    source: vehicle,
    value: "p39b",
    sequence: 41,
    status: "applied",
    version: 11,
    changed: [fleet, journey],
    targets: [f("position"), j],
  },
  {
    at: 320,
    entity: "car-39",
    source: operations,
    value: "o39b",
    sequence: 101,
    status: "applied",
    version: 12,
    changed: [fleet],
    targets: [f("operation")],
  },
];
type State = {
  view: string;
  entity: string;
  version: number;
  fields: Record<string, Value | Value[]>;
  floors: Record<string, number | null>;
};
const F = (
  entity: string,
  version: number,
  p: Value | null,
  o: Value | null,
  pf: number | null,
  of: number | null,
): State => ({
  view: fleet,
  entity,
  version,
  fields: { ...(p ? { position: p } : {}), ...(o ? { operation: o } : {}) },
  floors: { [vehicle]: pf, [operations]: of },
});
const J = (
  entity: string,
  version: number,
  positions: Value[],
  floor: number | null,
): State => ({
  view: journey,
  entity,
  version,
  fields: positions.length ? { positions } : {},
  floors: { [vehicle]: floor },
});
// Each row is an authored installed state, not a transition computed from publications.
export const states = {
  f17empty: F("car-17", 0, null, null, null, null),
  j17empty: J("car-17", 0, [], null),
  f28empty: F("car-28", 0, null, null, null, null),
  j28empty: J("car-28", 0, [], null),
  f39empty: F("car-39", 0, null, null, null, null),
  j39empty: J("car-39", 0, [], null),
  f17partial: F("car-17", 1, "p17a", null, 21, null),
  j17first: J("car-17", 1, ["p17a"], 21),
  f28partial: F("car-28", 2, "p28a", null, 21, null),
  j28first: J("car-28", 2, ["p28a"], 21),
  f39partial: F("car-39", 3, "p39a", null, 21, null),
  j39first: J("car-39", 3, ["p39a"], 21),
  f17first: F("car-17", 4, "p17a", "o17a", 21, 81),
  f28first: F("car-28", 5, "p28a", "o28a", 21, 81),
  f39first: F("car-39", 6, "p39a", "o39a", 21, 81),
  f17latest: F("car-17", 7, "p17c", "o17a", 23, 81),
  j17latest: J("car-17", 7, ["p17a", "p17c"], 23),
  f28latest: F("car-28", 8, "p28a", "o28c", 21, 83),
  j17late: J("car-17", 9, ["p17a", "p17b", "p17c"], 23),
  f39latest: F("car-39", 11, "p39b", "o39a", 22, 81),
  j39latest: J("car-39", 11, ["p39a", "p39b"], 22),
  f39final: F("car-39", 12, "p39b", "o39b", 22, 82),
};
type StateName = keyof typeof states;
export const subscriptions: [number, StateName][] = [
  [0, "f17empty"],
  [10, "j17empty"],
  [20, "f28empty"],
  [30, "j28empty"],
  [40, "f39empty"],
  [50, "j39empty"],
];
// Actual expected emission order; the late operation, retries and conflicts emit no frame.
export const updates: [number, StateName][] = [
  [60, "f17partial"],
  [60, "j17first"],
  [70, "f28partial"],
  [70, "j28first"],
  [80, "f39partial"],
  [80, "j39first"],
  [90, "f17first"],
  [100, "f28first"],
  [110, "f39first"],
  [180, "f17latest"],
  [180, "j17latest"],
  [190, "f28latest"],
  [240, "j17late"],
  [310, "f39latest"],
  [310, "j39latest"],
  [320, "f39final"],
];
// All 11 client and nine HTTP legacy checkpoint intents, at the original settled timestamps.
export const checkpoints: [number, "client" | "runtime", StateName][] = [
  [120, "client", "f17first"],
  [130, "client", "j17first"],
  [140, "client", "f28first"],
  [150, "client", "j28first"],
  [160, "client", "f39first"],
  [170, "client", "j39first"],
  [200, "runtime", "f17latest"],
  [210, "client", "f17latest"],
  [220, "runtime", "f28latest"],
  [230, "client", "f28latest"],
  [260, "client", "j17late"],
  [330, "runtime", "f39final"],
  [340, "runtime", "f17latest"],
  [360, "runtime", "j17late"],
  [380, "runtime", "f28latest"],
  [400, "runtime", "j28first"],
  [420, "runtime", "f39final"],
  [430, "client", "f39final"],
  [440, "runtime", "j39latest"],
  [450, "client", "j39latest"],
];
const identity = (sourceId: string, sourceEntityId: string) => ({
  sourceId,
  epoch: "run",
  sourceEntityId,
});
const sourceFor = (field: string) =>
  field === "operation" ? operations : vehicle;
export function snapshot(name: StateName) {
  const row = states[name];
  const names = row.view === fleet ? ["operation", "position"] : ["positions"];
  const retained = (key: Value) => ({
    publicationSequence: values[key].sequence,
    payload: values[key],
  });
  const data = Object.fromEntries(
    Object.entries(row.fields).map(([field, value]) => [
      field,
      Array.isArray(value) ? value.map(retained) : retained(value),
    ]),
  );
  const missingFields = names.filter((field) => !(field in row.fields));
  return {
    viewId: row.view,
    entityId: row.entity,
    version: row.version,
    data,
    provenance: Object.fromEntries(
      Object.keys(row.fields).map((field) => [
        field,
        identity(sourceFor(field), row.entity),
      ]),
    ),
    status: {
      publication: missingFields.length ? "partial" : "ready",
      missingFields,
      missingRequiredFields: [],
      fields: Object.fromEntries(
        names.map((field) => [
          field,
          {
            freshness: field in row.fields ? "unspecified" : "absent",
            receivedAtMillis: null,
            inputs: [sourceFor(field)],
          },
        ]),
      ),
      inputs: Object.fromEntries(
        Object.entries(row.floors).map(([source, floor]) => [
          source,
          {
            state: floor === null ? "notObserved" : "observed",
            mode: "untracked",
            epoch: "run",
            sourceEntityId: row.entity,
            startSequence: null,
            observedThrough: null,
            watermarkThrough: null,
            completeThrough: null,
            completeness: "unknown",
            admissionFloor: floor,
            sourceContractViolated: false,
            missingRanges: [],
          },
        ]),
      ),
    },
  };
}
export function frame(name: StateName) {
  const row = states[name];
  return {
    ...snapshot(name),
    type: "view-update",
    data: Object.fromEntries(
      Object.entries(row.fields).map(([field, value]) => [
        field,
        Array.isArray(value) ? value.map((key) => values[key]) : values[value],
      ]),
    ),
    publicationSequences: Object.fromEntries(
      Object.entries(row.fields).map(([field, value]) => [
        field,
        (Array.isArray(value) ? value : [value]).map(
          (key) => values[key].sequence,
        ),
      ]),
    ),
  };
}
export function receipt(event: Event) {
  return {
    status: event.status,
    reason:
      event.status === "duplicate"
        ? "alreadyApplied"
        : event.status === "rejected"
          ? "identityConflict"
          : "memory",
    stream: identity(event.source, event.entity),
    publicationSequence: event.sequence,
    version: event.version,
    changedViews: event.changed,
    targets: event.targets.map(([viewId, field, changed]) => ({
      viewId,
      entityId: event.entity,
      status: "accepted",
      reason: null,
      changedFields: changed ? [field] : [],
      fields: [{ field, status: "accepted", reason: null, changed }],
    })),
  };
}
export function framesAt(at: number) {
  return [
    ...subscriptions
      .filter(([time]) => time <= at)
      .flatMap(([, name]) => [
        {
          type: "subscribed",
          viewId: states[name].view,
          entityId: states[name].entity,
          recovery: "freshSnapshot",
        },
        frame(name),
      ]),
    ...updates.filter(([time]) => time <= at).map(([, name]) => frame(name)),
  ];
}
export const configuration = {
  contractVersion: 2,
  storage: "memory",
  maxStreams: 20,
  identityWindow: 20,
  maxHistoryEntries: 20,
  sources: [
    { id: vehicle, epoch: "run" },
    { id: operations, epoch: "run" },
  ],
  views: [
    {
      id: fleet,
      fields: {
        position: {
          sourceId: vehicle,
          type: "vehicle.location.updated",
          mode: "latestBySequence",
        },
        operation: {
          sourceId: operations,
          type: "vehicle.operation.updated",
          mode: "latestBySequence",
        },
      },
    },
    {
      id: journey,
      fields: {
        positions: {
          sourceId: vehicle,
          type: "vehicle.location.updated",
          mode: "historyBySequence",
        },
      },
    },
  ],
  delivery: {
    slowClient: "disconnectOnOverflow",
    maxQueuedMessages: 128,
    maxQueuedBytes: 65536,
  },
};
export const configurationWire = JSON.stringify(configuration, null, 2) + "\n";
export function buildDocument() {
  const actors = [
    { id: vehicle, role: "source" },
    { id: operations, role: "source" },
    { id: viewer, role: "client" },
  ];
  const actions = [
    ...actors.map(({ id }) => ({
      id: `connect-${id}`,
      atMs: 0,
      kind: "connect",
      actor: id,
    })),
    ...subscriptions.map(([atMs, name]) => ({
      id: `subscribe-${name}`,
      atMs,
      kind: "client-subscribe",
      actor: viewer,
      viewId: states[name].view,
      entityId: states[name].entity,
    })),
    ...events.map((event) => ({
      id: `send-${event.at}`,
      atMs: event.at,
      kind: "source-send",
      actor: event.source,
      publication: `publication-${event.at}`,
    })),
  ].sort((a, b) => a.atMs - b.atMs);
  const clientCheck = (id: string, atMs: number) => ({
    id,
    atMs,
    kind: "client-frames",
    actor: viewer,
    expected: framesAt(atMs),
  });
  const installedCheck = (id: string, atMs: number, name: StateName) => ({
    id,
    atMs,
    kind: "runtime-snapshot",
    viewId: states[name].view,
    entityId: states[name].entity,
    expected: { outcome: "available", snapshot: snapshot(name) },
  });
  const assertions = [
    ...checkpoints.map(([at, kind, name]) =>
      kind === "client"
        ? clientCheck(`legacy-client-${at}-${name}`, at)
        : installedCheck(`legacy-runtime-${at}-${name}`, at, name),
    ),
    ...[50, 60, 80, 240, 250, 270, 280, 290, 300, 450].map((at) =>
      clientCheck(`frames-${at}`, at),
    ),
    ...updates
      .filter(([at]) => [60, 70, 80, 180, 190, 240].includes(at))
      .map(([at, name]) => installedCheck(`state-${at}-${name}`, at, name)),
    ...(
      [
        "f17latest",
        "j17late",
        "f28latest",
        "j28first",
        "f39final",
        "j39latest",
      ] as StateName[]
    ).map((name) => installedCheck(`final-${name}`, 450, name)),
    ...events.map((event) => ({
      id: `receipts-${event.at}`,
      atMs: event.at,
      kind: "source-receipts",
      actor: event.source,
      expected: events
        .filter(
          (prior) => prior.source === event.source && prior.at <= event.at,
        )
        .map(receipt),
    })),
  ].sort((a, b) => a.atMs - b.atMs);
  return {
    format: "timeline-simulation/v2",
    id: "three-vehicle-sequence-fleet",
    clock: { epochMillis: 1700000000000 },
    seed: "0".repeat(64),
    runtime: {
      configuration: "runtime.json",
      sha256: createHash("sha256").update(configurationWire).digest("hex"),
      storage: "memory",
      access: "unprotected",
      initialState: "empty",
      profile: "memory-sequence-fleet-v1",
    },
    actors,
    links: actors.map(({ id }) => ({ actor: id, latencyMs: 0 })),
    observationTargets: subscriptions.map(([, name]) => ({
      viewId: states[name].view,
      entityId: states[name].entity,
    })),
    publications: events.map((event) => ({
      id: `publication-${event.at}`,
      body: {
        ...identity(event.source, event.entity),
        publicationSequence: event.sequence,
        type:
          event.source === vehicle
            ? "vehicle.location.updated"
            : "vehicle.operation.updated",
        payload: values[event.value],
      },
    })),
    actions,
    assertions,
    limits: {
      turns: 2000,
      rounds: 100,
      queuedEvents: 1000,
      pendingMessages: 1000,
      traceBytes: 4194304,
    },
    untilMs: 450,
    end: { pendingFutureTasks: "forbid", pendingMessages: 0, heldFrames: 0 },
  };
}
// One line per top-level array entry keeps generated output navigable without repeating
// thousands of indentation lines. Edit the compact authored tables above, never runtime output.
export function documentWire() {
  return (
    "{\n" +
    Object.entries(buildDocument())
      .map(
        ([key, value]) =>
          `  ${JSON.stringify(key)}: ${Array.isArray(value) ? "[\n" + value.map((item) => "    " + JSON.stringify(item)).join(",\n") + "\n  ]" : JSON.stringify(value)}`,
      )
      .join(",\n") +
    "\n}\n"
  );
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await writeFile(new URL("runtime.json", import.meta.url), configurationWire);
  await writeFile(new URL("scenario.json", import.meta.url), documentWire());
}
