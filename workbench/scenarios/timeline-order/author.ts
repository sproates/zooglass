/** Generate the runnable document solely from fixed inputs and authored oracle tables.
 * Run `node --import tsx scenarios/timeline-order/author.ts` from workbench.
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { epoch, inputs, sourceIds } from "./inputs.js";
import { frame, snapshot, summary, tracking } from "./observations.js";
import { emissions, orderOne } from "./order-one.js";
import { checkpoints } from "./checkpoints.js";
import { receipt, controlReceipts } from "./receipts.js";
export const configurationSha256 =
  "d3398885305dc27c409ad3cea3f9035d7c024e572ee2ee16354421a74fad1a33";
export const viewer = "order-viewer",
  progressActor = "order-progress";
export function framesAt(atMs: number) {
  return [
    ...[summary, tracking].flatMap((viewId) => [
      {
        type: "subscribed",
        viewId,
        entityId: "order-1",
        recovery: "freshSnapshot",
      },
      frame(orderOne.empty, viewId),
    ]),
    ...emissions
      .filter(([at]) => at <= atMs)
      .flatMap(([, name, views]) =>
        views.map((viewId) => frame(orderOne[name], viewId)),
      ),
  ];
}
export function buildDocument() {
  const input = inputs();
  // Explicit retry attempts reference their original retained body; this is input
  // serialization, independent of the receipt oracle's original versions/targets.
  const retained = new Map<string, string>();
  const publicationRefs = new Map<string, string>();
  for (const send of input.sends) {
    const wire = JSON.stringify(send.body);
    if (send.retry) {
      const original = retained.get(wire);
      if (!original)
        throw new Error(`Missing original publication for ${send.id}`);
      publicationRefs.set(send.id, original);
    } else {
      retained.set(wire, send.id);
      publicationRefs.set(send.id, send.id);
    }
  }
  const actors = [
    ...sourceIds.map((id) => ({ id, role: "source" })),
    { id: progressActor, role: "progress" },
    { id: viewer, role: "client" },
  ];
  const actions = [
    ...actors.map(({ id }) => ({
      id: `connect-${id}`,
      atMs: 0,
      kind: "connect",
      actor: id,
    })),
    ...[summary, tracking].map((viewId) => ({
      id: `subscribe-${viewId}`,
      atMs: 0,
      kind: "client-subscribe",
      actor: viewer,
      viewId,
      entityId: "order-1",
    })),
    ...input.connections.map((connection) => ({
      id: connection.id,
      atMs: connection.atMs,
      kind: connection.kind,
      actor: connection.source,
    })),
    ...input.sends.map((send) => ({
      id: `send-${send.id}`,
      atMs: send.atMs,
      kind: send.retry ? "source-retry" : "source-send",
      actor: send.body.sourceId,
      publication: publicationRefs.get(send.id)!,
    })),
    ...input.controls.map((control) => ({
      id: control.id,
      atMs: control.atMs,
      kind: "progress-send",
      actor: progressActor,
      control: control.control,
    })),
  ].sort((a, b) => a.atMs - b.atMs);
  const assertions = [
    ...checkpoints.flatMap((check) =>
      check.views.map((viewId) => ({
        id: `${check.id}-${viewId}`,
        atMs: check.atMs,
        kind: "runtime-snapshot",
        viewId,
        entityId: `order-${check.row.index + 1}`,
        expected: {
          outcome: "available",
          snapshot: snapshot(check.row, viewId),
        },
      })),
    ),
    ...[0, 21100, 24100, 105100, 111100, 129100, 213000].map((atMs) => ({
      id: `complete-client-frames-${atMs}`,
      atMs,
      kind: "client-frames",
      actor: viewer,
      expected: framesAt(atMs),
    })),
    ...[105100, 213000].flatMap((atMs) =>
      sourceIds.map((source) => ({
        id: `complete-${source}-receipts-${atMs}`,
        atMs,
        kind: "source-receipts",
        actor: source,
        expected: input.sends
          .filter((send) => send.body.sourceId === source && send.atMs <= atMs)
          .map(receipt),
      })),
    ),
    ...[102100, 213000].map((atMs) => ({
      id: `complete-watermarks-${atMs}`,
      atMs,
      kind: "control-receipts",
      actor: progressActor,
      expected: controlReceipts().filter(
        (_, index) => input.controls[index].atMs <= atMs,
      ),
    })),
  ].sort((a, b) => a.atMs - b.atMs);
  return {
    format: "timeline-simulation/v2",
    id: "six-orders-two-cycles",
    clock: { epochMillis: epoch },
    seed: "0".repeat(64),
    runtime: {
      configuration: "runtime.json",
      sha256: configurationSha256,
      storage: "sqlite",
      access: "unprotected",
      initialState: "empty",
      profile: "sqlite-order-v1",
    },
    actors,
    links: actors.map(({ id }) => ({ actor: id, latencyMs: 0 })),
    observationTargets: Array.from({ length: 6 }, (_, index) =>
      [summary, tracking].map((viewId) => ({
        viewId,
        entityId: `order-${index + 1}`,
      })),
    ).flat(),
    publications: input.sends
      .filter((send) => !send.retry)
      .map((send) => ({ id: send.id, body: send.body })),
    actions,
    assertions,
    limits: {
      turns: 2000,
      rounds: 100,
      queuedEvents: 1000,
      pendingMessages: 1000,
      traceBytes: 16777216,
    },
    untilMs: 213000,
    end: { pendingFutureTasks: "allow", pendingMessages: 0, heldFrames: 0 },
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
    throw new Error("Pinned Order configuration bytes changed");
  await writeFile(new URL("scenario.json", import.meta.url), documentWire());
}
