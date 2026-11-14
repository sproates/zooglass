/** Generate bounded recovery documents from fixed inputs and independently authored oracles. */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
  beforeSends,
  controlA,
  controlB,
  epoch,
  progress,
  publications,
  source,
  summary,
  targets,
  tracking,
  variants,
  viewers,
  type PublicationId,
  type Variant,
} from "./inputs.js";
import {
  frame,
  receipt,
  recovered,
  snapshot,
  watermark,
  type RowName,
} from "./oracle.js";
export const configurationSha256 =
  "d3398885305dc27c409ad3cea3f9035d7c024e572ee2ee16354421a74fad1a33";
const both = [summary, tracking];
export function recoverySnapshots(variant: Variant) {
  return recovered[variant].flatMap((name) =>
    both.map((view) => snapshot(name, view, variant)),
  );
}
function baseline(names: RowName[], variant: Variant) {
  return names.flatMap((name) =>
    both.flatMap((viewId) => [
      {
        type: "subscribed",
        viewId,
        entityId: snapshot(name, viewId, variant).entityId,
        recovery: "freshSnapshot",
      },
      frame(name, viewId, variant),
    ]),
  );
}
const beforeEmissions: [number, RowName][] = [
  [1, "order1"],
  [2, "order2"],
  [10, "backup1"],
  [11, "backup2"],
  [20, "inventory1"],
  [21, "primary1"],
  [22, "primary2"],
  [40, "committedA"],
];
export function framesAt(variant: Variant, at: number) {
  const { restart } = variants[variant];
  const original = [
    ...baseline(["empty1", "empty2"], variant),
    ...beforeEmissions
      .filter(([time]) => time <= at)
      .flatMap(([, name]) => both.map((view) => frame(name, view, variant))),
  ];
  if (at < restart) return original;
  const after: [number, RowName][] =
    variant === "after"
      ? [
          [13, "committedB"],
          [14, "gateOpened"],
          [16, "readyGateRetained"],
          [18, "primaryRefreshed"],
          [19, "inventoryRefreshed"],
        ]
      : [[0, "boundaryNextOrder2"]];
  return [
    ...original,
    ...baseline(recovered[variant], variant),
    ...after
      .filter(([time]) => restart + time <= at)
      .flatMap(([, name]) => both.map((view) => frame(name, view, variant))),
  ];
}
export function sourceReceipts(variant: Variant, at: number) {
  const original = beforeSends
    .filter(([time]) => time <= at)
    .map(([, id]) => receipt(id));
  const after: [number, PublicationId, boolean][] =
    variant === "after"
      ? [
          [1, "primary1", true],
          [14, "inventory2", false],
          [15, "primary2", true],
          [16, "nextOrder1", false],
          [17, "freshBackup1", false],
          [18, "freshPrimary1", false],
          [19, "freshInventory1", false],
        ]
      : [[0, "nextOrder2", false]];
  return [
    ...original,
    ...after
      .filter(([time]) => variants[variant].restart + time <= at)
      .map(([, id, duplicate]) => receipt(id, duplicate)),
  ];
}
export function buildDocument(variant: Variant = "after") {
  const { restart, until, mode } = variants[variant];
  const actors = [
    { id: source, role: "source" },
    { id: progress, role: "progress" },
    ...viewers.map((id) => ({ id, role: "client" })),
  ];
  const connect = (atMs: number) =>
    actors.map(({ id }) => ({
      id: `connect-${id}-${atMs}`,
      atMs,
      kind: "connect",
      actor: id,
    }));
  const subscribe = (atMs: number) =>
    viewers.flatMap((actor) =>
      targets.map((target) => ({
        id: `subscribe-${actor}-${target.viewId}-${target.entityId}-${atMs}`,
        atMs,
        kind: "client-subscribe",
        actor,
        ...target,
      })),
    );
  const send = (id: PublicationId, atMs: number, retry = false) => ({
    id: `${retry ? "retry" : "send"}-${id}-${atMs}`,
    atMs,
    kind: retry ? "source-retry" : "source-send",
    actor: source,
    publication: id,
  });
  const control = (id: string, atMs: number, body: typeof controlA) => ({
    id,
    atMs,
    kind: "progress-send",
    actor: progress,
    control: body,
  });
  const after =
    variant === "after"
      ? [
          send("primary1", restart + 1, true),
          control("repeat-A", restart + 2, controlA),
          control("repeat-B", restart + 3, controlB),
          send("inventory2", restart + 14),
          send("primary2", restart + 15, true),
          send("nextOrder1", restart + 16),
          send("freshBackup1", restart + 17),
          send("freshPrimary1", restart + 18),
          send("freshInventory1", restart + 19),
        ]
      : [send("nextOrder2", restart)];
  const actions = [
    ...connect(0),
    ...subscribe(0),
    ...beforeSends.map(([at, id]) => send(id, at)),
    control("original-A", 30, controlA),
    control("original-B", 45, controlB),
    { id: "stop", atMs: 48, kind: "service-stop", mode },
    { id: "restart", atMs: restart, kind: "service-start" },
    ...connect(restart),
    ...subscribe(restart),
    ...after,
  ].sort((a, b) => a.atMs - b.atMs);
  const installed = (id: string, atMs: number, name: RowName) =>
    both.map((viewId) => ({
      id: `${id}-${viewId}`,
      atMs,
      kind: "runtime-snapshot",
      viewId,
      entityId: snapshot(name, viewId, variant).entityId,
      expected: {
        outcome: "available",
        snapshot: snapshot(name, viewId, variant),
      },
    }));
  const frames = (atMs: number) =>
    viewers.map((actor) => ({
      id: `frames-${actor}-${atMs}`,
      atMs,
      kind: "client-frames",
      actor,
      expected: framesAt(variant, atMs),
    }));
  const receipts = (atMs: number) => ({
    id: `source-receipts-${atMs}`,
    atMs,
    kind: "source-receipts",
    actor: source,
    expected: sourceReceipts(variant, atMs),
  });
  const acknowledgements = (id: string, atMs: number, expected: unknown[]) => ({
    id,
    atMs,
    kind: "control-receipts",
    actor: progress,
    expected,
  });
  const recovery =
    variant === "after"
      ? [
          ...installed("recovered-ready", restart, "recoveredAfter1"),
          ...installed("recovered-gated", restart, "recoveredAfter2"),
          ...installed(
            "duplicate-retains-primary-age",
            restart + 1,
            "recoveredAfter1",
          ),
          ...installed("B-first-commit", restart + 13, "committedB"),
          ...installed(
            "inventory-opens-retained-gate",
            restart + 14,
            "gateOpened",
          ),
          ...installed(
            "duplicate-retains-original-gated-disposition",
            restart + 15,
            "gateOpened",
          ),
          ...installed(
            "ready-gate-does-not-reset",
            restart + 16,
            "readyGateRetained",
          ),
          ...installed(
            "fresh-backup-does-not-displace-stale-primary",
            restart + 17,
            "readyGateRetained",
          ),
          ...installed(
            "fresh-primary-restores-delivery",
            restart + 18,
            "primaryRefreshed",
          ),
          ...installed(
            "fresh-inventory-restores-stock",
            restart + 19,
            "inventoryRefreshed",
          ),
          acknowledgements(
            "no-old-or-premature-control-acks",
            restart + 21,
            [],
          ),
          acknowledgements("A-original-version", restart + 22, [
            watermark("A", true),
          ]),
          acknowledgements("B-not-previously-committed", restart + 23, [
            watermark("A", true),
            watermark("B"),
          ]),
        ]
      : [
          ...installed("boundary-ready", restart, recovered[variant][0]),
          ...installed(
            "hidden-recovery-commit-before-next-publication",
            restart,
            "boundaryNextOrder2",
          ),
          acknowledgements("cancelled-control-acks-remain-absent", restart, []),
        ];
  const assertions = [
    ...installed("initial-ready-entity", 0, "empty1"),
    ...installed("initial-gated-entity", 0, "empty2"),
    ...frames(0),
    ...installed("committed-A-before-lost-ack", 47, "committedA"),
    ...installed("B-request-not-yet-arrived", 47, "primary2"),
    ...frames(47),
    receipts(47),
    acknowledgements("A-ack-not-yet-delivered", 47, []),
    {
      id: "runtime-unavailable",
      atMs: 60,
      kind: "runtime-snapshot",
      ...targets[0],
      expected: { outcome: "runtime-unavailable" },
    },
    ...frames(60),
    acknowledgements("old-control-ack-and-request-cancelled", 60, []),
    ...recovery,
    ...frames(until),
    receipts(until),
  ].sort((a, b) => a.atMs - b.atMs);
  const retained = new Set([
    ...beforeSends.map(([, id]) => id),
    ...(variant === "after"
      ? [
          "inventory2",
          "nextOrder1",
          "freshBackup1",
          "freshPrimary1",
          "freshInventory1",
        ]
      : ["nextOrder2"]),
  ]);
  return {
    format: "timeline-simulation/v2",
    id: `order-recovery-${variant}-boundary`,
    clock: { epochMillis: epoch },
    seed: "0".repeat(64),
    runtime: {
      configuration: "runtime.json",
      sha256: configurationSha256,
      storage: "sqlite",
      access: "unprotected",
      initialState: "empty",
      profile: "sqlite-order-restart-v1",
    },
    actors,
    links: actors.map(({ id }) => ({
      actor: id,
      latencyMs: id === progress ? 10 : 0,
    })),
    observationTargets: targets,
    publications: Object.entries(publications)
      .filter(([id]) => retained.has(id))
      .map(([id, body]) => ({ id, body })),
    actions,
    assertions,
    limits: {
      turns: 2000,
      rounds: 100,
      queuedEvents: 1000,
      pendingMessages: 1000,
      traceBytes: 16777216,
    },
    untilMs: until,
    end: { pendingFutureTasks: "allow", pendingMessages: 0, heldFrames: 0 },
  };
}
export function documentWire(variant: Variant) {
  return (
    "{\n" +
    Object.entries(buildDocument(variant))
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
  const config = await readFile(new URL("runtime.json", import.meta.url));
  if (createHash("sha256").update(config).digest("hex") !== configurationSha256)
    throw new Error("Pinned Order configuration changed");
  for (const variant of Object.keys(variants) as Variant[])
    await writeFile(
      new URL(`${variant}.json`, import.meta.url),
      documentWire(variant),
    );
}
