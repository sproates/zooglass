import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import {
  actors,
  publications,
  sends,
  controls,
  watermark,
  views,
} from "./inputs.js";
import {
  checkpoints,
  snapshot,
  sourceReceipts,
  controlReceipts,
  progressReceipt,
} from "./oracle.js";
export const configurationSha256 =
  "775781cbf4e64abfb9a4a7ea1c61f8e7f904d3e743f5e8e660bec536e9e367ae";
export function buildDocument() {
  const actions = [
    ...Object.values(actors).map((actor) => ({
      id: `connect-${actor}`,
      atMs: 0,
      kind: "connect",
      actor,
    })),
    ...sends.map((send) => ({
      ...send,
      kind: [
        "new-after-retirement",
        "retained-duplicate",
        "inclusive-duplicate",
        "evicted",
      ].includes(send.id)
        ? "source-retry"
        : "source-send",
      actor: actors.source,
    })),
    ...controls.map((control) => ({
      ...control,
      kind: "retirement-send",
      actor: actors.retirement,
    })),
    {
      id: "watermark",
      atMs: 310,
      kind: "progress-send",
      actor: actors.progress,
      control: watermark,
    },
    {
      id: "close-lost-reply",
      atMs: 1003,
      kind: "disconnect",
      actor: actors.retirement,
    },
    { id: "reconnect", atMs: 1004, kind: "connect", actor: actors.retirement },
  ].sort((a, b) => a.atMs - b.atMs);
  const assertions = [
    ...sends.map((send) => ({
      id: `${send.id}-receipt`,
      atMs: send.atMs + 1,
      kind: "source-receipts",
      actor: actors.source,
      expected: sourceReceipts(send.atMs),
    })),
    ...checkpoints.flatMap((point) =>
      views.map((viewId, index) => ({
        id: `${point.id}-${viewId}`,
        atMs: point.atMs,
        kind: "runtime-snapshot",
        viewId,
        entityId: "match-1",
        expected: { outcome: "available", snapshot: snapshot(point, index) },
      })),
    ),
    ...[204, 214, 224, 234, 1003, 1010].map((atMs) => ({
      id: `retirement-receipts-${atMs}`,
      atMs,
      kind: "control-receipts",
      actor: actors.retirement,
      expected: controlReceipts(atMs),
    })),
    {
      id: "watermark-receipt",
      atMs: 311,
      kind: "control-receipts",
      actor: actors.progress,
      expected: [progressReceipt],
    },
  ].sort((a, b) => a.atMs - b.atMs);
  return {
    format: "timeline-simulation/v2",
    id: "sports-fact-and-identity-retention",
    clock: { epochMillis: 1700000000000 },
    seed: "0".repeat(64),
    runtime: {
      configuration: "runtime.json",
      sha256: configurationSha256,
      storage: "sqlite",
      access: "unprotected",
      initialState: "empty",
      profile: "sqlite-sports-v1",
    },
    actors: [
      { id: actors.source, role: "source" },
      { id: actors.retirement, role: "retirement" },
      { id: actors.progress, role: "progress" },
    ],
    links: Object.values(actors).map((actor) => ({
      actor,
      latencyMs: actor === actors.retirement ? 2 : 0,
    })),
    publications: Object.entries(publications).map(([id, body]) => ({
      id,
      body,
    })),
    actions,
    assertions,
    observationTargets: views.map((viewId) => ({
      viewId,
      entityId: "match-1",
    })),
    limits: {
      turns: 2000,
      rounds: 100,
      queuedEvents: 1000,
      pendingMessages: 1000,
      traceBytes: 16777216,
    },
    untilMs: 1010,
    end: { pendingFutureTasks: "forbid", pendingMessages: 0, heldFrames: 0 },
  };
}
export const documentWire = () =>
  JSON.stringify(buildDocument(), null, 2) + "\n";
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const target = new URL("scenario.json", import.meta.url);
  if (process.argv.includes("--check")) {
    if ((await readFile(target, "utf8")) !== documentWire())
      throw new Error(
        "Retained Sports retention document differs from authored expectations",
      );
  } else await writeFile(fileURLToPath(target), documentWire());
}
