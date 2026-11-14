/** Generate the sparse retention fixture from fixed inputs and independent expected rows. */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
  attempts,
  controls,
  epoch,
  progress,
  publications,
  source,
  stream,
  viewer,
  views,
} from "./inputs.js";
import { frame, receipt, snapshot, type RowName } from "./oracle.js";
export const configurationSha256 =
  "d3398885305dc27c409ad3cea3f9035d7c024e572ee2ee16354421a74fad1a33";
export const emissions: [number, RowName][] = [
  [10, "first"],
  [11, "firstWatermark"],
  [20, "edge"],
  [30, "lastInWindow"],
  [40, "crossedWindow"],
  [46, "confirmed"],
  [65, "provisionalClosed"],
  [66, "violated"],
];
const baseline = (name: RowName) =>
  views.flatMap((viewId) => [
    {
      type: "subscribed",
      viewId,
      entityId: "order-1",
      recovery: "freshSnapshot",
    },
    frame(name, viewId),
  ]);
export function framesAt(atMs: number) {
  return [
    ...baseline("empty"),
    ...emissions
      .filter(([at]) => at <= atMs && at < 50)
      .flatMap(([, name]) => views.map((view) => frame(name, view))),
    ...(atMs >= 60 ? baseline("confirmed") : []),
    ...emissions
      .filter(([at]) => at <= atMs && at > 60)
      .flatMap(([, name]) => views.map((view) => frame(name, view))),
  ];
}
export function controlReceipts(atMs: number) {
  return controls
    .filter((control) => control.atMs <= atMs)
    .map(({ atMs: at, ...control }) => {
      void at;
      return { kind: "watermark", stream, ...control };
    });
}
export const checkpoints: [string, number, RowName][] = [
  ["empty", 0, "empty"],
  ["accepted-first", 10, "first"],
  ["complete-watermark-one", 11, "firstWatermark"],
  ["provisional-gap-two", 20, "edge"],
  ["inclusive-window-128", 30, "lastInWindow"],
  ["first-identity-still-retained", 31, "lastInWindow"],
  ["crossed-window-gap-expired", 40, "crossedWindow"],
  ["evicted-original-rejected", 41, "crossedWindow"],
  ["eviction-precedes-content-conflict", 42, "crossedWindow"],
  ["retained-edge-duplicate", 43, "crossedWindow"],
  ["retained-edge-conflict", 44, "crossedWindow"],
  ["old-watermark-survives-publication-floor", 45, "crossedWindow"],
  ["watermark-confirms-without-moving-floor", 46, "confirmed"],
  ["duplicate-below-watermark-does-not-violate", 47, "confirmed"],
  ["restored-floor-gaps-and-values", 60, "confirmed"],
  ["recovered-watermark-duplicate", 61, "confirmed"],
  ["recovered-retained-edge-duplicate", 62, "confirmed"],
  ["recovered-evicted-original-rejected", 63, "confirmed"],
  ["expired-unseen-gap-cannot-be-filled", 64, "confirmed"],
  ["late-input-closes-provisional-gap", 65, "provisionalClosed"],
  ["new-confirmed-late-input-violates-contract", 66, "violated"],
  ["backwards-watermark-rejected", 67, "violated"],
  ["latest-watermark-keeps-original-version", 68, "violated"],
];
export function buildDocument() {
  const actors = [
    { id: source, role: "source" },
    { id: progress, role: "progress" },
    { id: viewer, role: "client" },
  ];
  const connect = (atMs: number) =>
    actors.map(({ id }) => ({
      id: `connect-${id}-${atMs}`,
      atMs,
      kind: "connect",
      actor: id,
    }));
  const subscribe = (atMs: number) =>
    views.map((viewId) => ({
      id: `subscribe-${viewId}-${atMs}`,
      atMs,
      kind: "client-subscribe",
      actor: viewer,
      viewId,
      entityId: "order-1",
    }));
  const actions = [
    ...connect(0),
    ...subscribe(0),
    ...attempts.map((attempt) => ({
      id: `publication-${attempt.atMs}`,
      atMs: attempt.atMs,
      kind: attempt.retry ? "source-retry" : "source-send",
      actor: source,
      publication: attempt.publication,
    })),
    ...controls.map((control) => ({
      id: `watermark-${control.atMs}`,
      atMs: control.atMs,
      kind: "progress-send",
      actor: progress,
      control: { ...stream, throughSequence: control.throughSequence },
    })),
    { id: "stop", atMs: 50, kind: "service-stop", mode: "abrupt" },
    { id: "restart", atMs: 60, kind: "service-start" },
    ...connect(60),
    ...subscribe(60),
  ].sort((a, b) => a.atMs - b.atMs);
  const assertions = [
    ...checkpoints.flatMap(([id, atMs, name]) =>
      views.map((viewId) => ({
        id: `${id}-${viewId}`,
        atMs,
        kind: "runtime-snapshot",
        viewId,
        entityId: "order-1",
        expected: { outcome: "available", snapshot: snapshot(name, viewId) },
      })),
    ),
    {
      id: "runtime-unavailable",
      atMs: 55,
      kind: "runtime-snapshot",
      viewId: "order-summary",
      entityId: "order-1",
      expected: { outcome: "runtime-unavailable" },
    },
    ...[0, 47, 60, 70].map((atMs) => ({
      id: `client-frames-${atMs}`,
      atMs,
      kind: "client-frames",
      actor: viewer,
      expected: framesAt(atMs),
    })),
    ...[31, 44, 47, 64, 70].map((atMs) => ({
      id: `source-receipts-${atMs}`,
      atMs,
      kind: "source-receipts",
      actor: source,
      expected: attempts.filter((attempt) => attempt.atMs <= atMs).map(receipt),
    })),
    ...[45, 47, 61, 70].map((atMs) => ({
      id: `control-receipts-${atMs}`,
      atMs,
      kind: "control-receipts",
      actor: progress,
      expected: controlReceipts(atMs),
    })),
  ].sort((a, b) => a.atMs - b.atMs);
  return {
    format: "timeline-simulation/v2",
    id: "order-retention-sequence-span",
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
    links: actors.map(({ id }) => ({ actor: id, latencyMs: 0 })),
    observationTargets: views.map((viewId) => ({
      viewId,
      entityId: "order-1",
    })),
    publications: Object.entries(publications).map(([id, body]) => ({
      id,
      body,
    })),
    actions,
    assertions,
    limits: {
      turns: 2000,
      rounds: 100,
      queuedEvents: 1000,
      pendingMessages: 1000,
      traceBytes: 16777216,
    },
    untilMs: 70,
    end: { pendingFutureTasks: "forbid", pendingMessages: 0, heldFrames: 0 },
  };
}
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
  const configuration = await readFile(
    new URL("runtime.json", import.meta.url),
  );
  if (
    createHash("sha256").update(configuration).digest("hex") !==
    configurationSha256
  )
    throw new Error("Pinned Order configuration changed");
  await writeFile(new URL("scenario.json", import.meta.url), documentWire());
}
