/** Runnable ordinary Sports fixture; expectations come only from the authored tables. */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
  actors,
  epoch,
  inputs,
  views,
  type PublicationInput,
  type ProgressInput,
  type RetirementInput,
} from "./inputs.js";
import { receipt, progressReceipt, retirementReceipt } from "./receipts.js";
import { rows, otherRows, state } from "./states.js";
import { frame, snapshot } from "./wire.js";
export const configurationSha256 =
  "775781cbf4e64abfb9a4a7ea1c61f8e7f904d3e743f5e8e660bec536e9e367ae";
export const untilMs = 360110;
const allInputs = inputs(),
  sends = allInputs.filter(
    (input): input is PublicationInput => input.kind === "publication",
  );
export function framesAt(atMs: number) {
  return [
    ...views.flatMap((viewId) => [
      {
        type: "subscribed",
        viewId,
        entityId: "match-1",
        recovery: "freshSnapshot",
      },
      frame(viewId, state(rows[0], viewId)),
    ]),
    ...rows
      .filter((row) => row.atMs <= atMs)
      .flatMap((row) =>
        row.emitted.map((viewId) => frame(viewId, state(row, viewId))),
      ),
  ];
}
export function buildDocument() {
  const declaredActors = [
    { id: actors.match, role: "source" },
    { id: actors.book, role: "source" },
    { id: actors.progress, role: "progress" },
    { id: actors.retirement, role: "retirement" },
    { id: actors.viewer, role: "client" },
  ];
  const retained = new Map<string, string>(),
    publications: { id: string; body: PublicationInput["body"] }[] = [];
  const sourceActions = sends.map((input) => {
    const wire = JSON.stringify(input.body),
      original = retained.get(wire);
    if (!original) {
      retained.set(wire, input.id);
      publications.push({ id: input.id, body: input.body });
    }
    return {
      id: `send-${input.id}`,
      atMs: input.atMs,
      kind: original ? "source-retry" : "source-send",
      actor: input.body.sourceId === "bookmaker" ? actors.book : actors.match,
      publication: original ?? input.id,
    };
  });
  const actions = [
    ...declaredActors.map(({ id }) => ({
      id: `connect-${id}`,
      atMs: 0,
      kind: "connect",
      actor: id,
    })),
    ...views.map((viewId) => ({
      id: `subscribe-${viewId}`,
      atMs: 0,
      kind: "client-subscribe",
      actor: actors.viewer,
      viewId,
      entityId: "match-1",
    })),
    ...sourceActions,
    ...allInputs
      .filter((input): input is ProgressInput => input.kind === "progress")
      .map((input) => ({
        id: input.id,
        atMs: input.atMs,
        kind: "progress-send",
        actor: actors.progress,
        control: input.control,
      })),
    ...allInputs
      .filter((input): input is RetirementInput => input.kind === "retirement")
      .map((input) => ({
        id: input.id,
        atMs: input.atMs,
        kind: "retirement-send",
        actor: actors.retirement,
        control: input.control,
      })),
    ...allInputs
      .filter(
        (input) => input.kind === "disconnect" || input.kind === "reconnect",
      )
      .map((input) => ({
        id: input.id,
        atMs: input.atMs,
        kind: input.kind === "reconnect" ? "connect" : "disconnect",
        actor: actors.book,
      })),
  ].sort((a, b) => a.atMs - b.atMs);
  const sourceAssertion = (id: string, atMs: number, sourceId: string) => ({
    id,
    atMs,
    kind: "source-receipts",
    actor: sourceId === "bookmaker" ? actors.book : actors.match,
    expected: sends
      .filter((input) => input.atMs <= atMs && input.body.sourceId === sourceId)
      .map(receipt),
  });
  const assertions = [
    // This receipt is declared before same-time snapshots: the wrong-revision control
    // must fail on target dispositions, not on a changed evidence identity.
    sourceAssertion(
      "corrected-scorer-cycle-1-match-1-source-receipt",
      54010,
      "match-feed",
    ),
    ...[36010, 81010, 174010, 249010, 360110].map((at) =>
      sourceAssertion(`match-receipts-${at}`, at, "match-feed"),
    ),
    sourceAssertion("all-bookmaker-receipts", untilMs, "bookmaker"),
    ...[
      ...rows.filter(
        (row, index) =>
          !rows.slice(index + 1).some((next) => next.atMs === row.atMs),
      ),
      ...otherRows,
    ].flatMap((row) =>
      views.map((viewId) => ({
        id: `${row.id}-${row.entityId}-${viewId}`,
        atMs: row.atMs,
        kind: "runtime-snapshot",
        viewId,
        entityId: row.entityId,
        expected: {
          outcome: "available",
          snapshot: snapshot(viewId, state(row, viewId)),
        },
      })),
    ),
    ...[0, 168012, 360110].map((atMs) => ({
      id: `all-client-frames-${atMs}`,
      atMs,
      kind: "client-frames",
      actor: actors.viewer,
      expected: framesAt(atMs),
    })),
    ...[111010, 360110].map((atMs) => ({
      id: `progress-acknowledgements-${atMs}`,
      atMs,
      kind: "control-receipts",
      actor: actors.progress,
      expected: allInputs
        .filter(
          (input): input is ProgressInput =>
            input.kind === "progress" && input.atMs <= atMs,
        )
        .map(progressReceipt),
    })),
    ...[168010, 168011, 168012, 186012].map((atMs) => ({
      id: `retirement-acknowledgements-${atMs}`,
      atMs,
      kind: "control-receipts",
      actor: actors.retirement,
      expected: allInputs
        .filter(
          (input): input is RetirementInput =>
            input.kind === "retirement" && input.atMs <= atMs,
        )
        .map(retirementReceipt),
    })),
  ].sort((a, b) => a.atMs - b.atMs);
  return {
    format: "timeline-simulation/v2",
    id: "sports-three-matches-two-cycles",
    clock: { epochMillis: epoch },
    seed: "0".repeat(64),
    runtime: {
      configuration: "runtime.json",
      sha256: configurationSha256,
      storage: "sqlite",
      access: "unprotected",
      initialState: "empty",
      profile: "sqlite-sports-v1",
    },
    actors: declaredActors,
    links: declaredActors.map(({ id }) => ({ actor: id, latencyMs: 0 })),
    observationTargets: ["match-1", "match-2", "match-3"].flatMap((entityId) =>
      views.map((viewId) => ({ viewId, entityId })),
    ),
    publications,
    actions,
    assertions,
    limits: {
      turns: 2000,
      rounds: 100,
      queuedEvents: 1000,
      pendingMessages: 1000,
      traceBytes: 16777216,
    },
    untilMs,
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
    throw new Error("Pinned Sports configuration changed");
  await writeFile(new URL("scenario.json", import.meta.url), documentWire());
}
