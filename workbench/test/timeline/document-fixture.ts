import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const epoch = 1700000000000;
export const source = "viewer-logical-source";
export const client = "source-logical-client";
const identity = {
  sourceId: "warehouse-feed",
  epoch: "day-1",
  sourceEntityId: "sku-4",
};
export const ack = {
  type: "subscribed",
  viewId: "stock-view",
  entityId: "sku-4",
  recovery: "freshSnapshot",
};
// Literal expected transitions supplied by each test, independent of runtime projections.
export function frame(
  version = 0,
  sequence = 0,
  freshness = "absent",
  receivedAt: number | null = null,
) {
  return {
    type: "view-update",
    viewId: "stock-view",
    entityId: "sku-4",
    version,
    data: version ? { reading: { amount: sequence } } : {},
    provenance: version ? { reading: identity } : {},
    publicationSequences: version ? { reading: [sequence] } : {},
    status: {
      publication: version ? "ready" : "partial",
      missingFields: version ? [] : ["reading"],
      missingRequiredFields: [],
      fields: {
        reading: {
          freshness,
          receivedAtMillis: receivedAt,
          inputs: ["warehouse-feed"],
        },
      },
      inputs: {
        "warehouse-feed": {
          state: version ? "observed" : "notObserved",
          mode: "untracked",
          epoch: "day-1",
          sourceEntityId: "sku-4",
          startSequence: null,
          observedThrough: null,
          watermarkThrough: null,
          completeThrough: null,
          completeness: "unknown",
          admissionFloor: version ? 1 : null,
          sourceContractViolated: false,
          missingRanges: [],
        },
      },
    },
  };
}
export function receipt(sequence: number, version: number, duplicate = false) {
  return {
    status: duplicate ? "duplicate" : "applied",
    reason: duplicate ? "alreadyApplied" : "memory",
    stream: identity,
    publicationSequence: sequence,
    version,
    changedViews: duplicate ? [] : ["stock-view"],
    targets: [
      {
        viewId: "stock-view",
        entityId: "sku-4",
        status: "accepted",
        reason: null,
        changedFields: ["reading"],
        fields: [
          { field: "reading", status: "accepted", reason: null, changed: true },
        ],
      },
    ],
  };
}
export function action(
  id: string,
  atMs: number,
  kind: string,
  actor: string,
  extras: Record<string, unknown> = {},
) {
  return { id, atMs, kind, actor, ...extras };
}
export function fixture() {
  const configuration = {
    contractVersion: 2,
    storage: "memory",
    maxStreams: 20,
    identityWindow: 20,
    maxHistoryEntries: 20,
    sources: [{ id: "warehouse-feed", epoch: "day-1" }],
    views: [
      {
        id: "stock-view",
        fields: {
          reading: {
            sourceId: "warehouse-feed",
            type: "stock",
            mode: "arrival",
            freshness: { mode: "receiptAge", staleAfterMillis: 50 },
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
  const document = {
    format: "timeline-simulation/v1",
    id: "warehouse-retry-and-expiry",
    clock: { epochMillis: epoch },
    seed: "0".repeat(64),
    runtime: {
      configuration: "runtime.json",
      sha256: "",
      storage: "memory",
      access: "unprotected",
      initialState: "empty",
    },
    actors: [
      { id: source, role: "source" },
      { id: client, role: "client" },
    ],
    links: [
      { actor: source, latencyMs: 0 },
      { actor: client, latencyMs: 0 },
    ],
    publications: [1, 2, 3, 4].map((sequence) => ({
      id: `report-${sequence}`,
      body: {
        ...identity,
        publicationSequence: sequence,
        type: "stock",
        payload: { amount: sequence },
      },
    })),
    actions: [
      action("source-connect", 0, "connect", source),
      action("client-connect", 0, "connect", client),
      action("subscribe", 0, "client-subscribe", client, {
        viewId: "stock-view",
        entityId: "sku-4",
      }),
      action("send-1", 10, "source-send", source, { publication: "report-1" }),
      action("source-disconnect", 15, "disconnect", source),
      action("source-reconnect", 16, "connect", source),
      action("retry", 20, "source-retry", source, { publication: "report-1" }),
      action("send-2", 60, "source-send", source, { publication: "report-2" }),
    ],
    assertions: [
      {
        id: "initial",
        atMs: 0,
        kind: "client-frames",
        actor: client,
        expected: [ack, frame()] as unknown[],
      },
      {
        id: "fresh",
        atMs: 59,
        kind: "client-frames",
        actor: client,
        expected: [ack, frame(), frame(1, 1, "fresh", epoch + 10)] as unknown[],
      },
      {
        id: "all-frames",
        atMs: 110,
        kind: "client-frames",
        actor: client,
        expected: [
          ack,
          frame(),
          frame(1, 1, "fresh", epoch + 10),
          frame(2, 1, "stale", epoch + 10),
          frame(3, 2, "fresh", epoch + 60),
          frame(4, 2, "stale", epoch + 60),
        ] as unknown[],
      },
      {
        id: "receipts",
        atMs: 110,
        kind: "source-receipts",
        actor: source,
        expected: [
          receipt(1, 1),
          receipt(1, 1, true),
          receipt(2, 3),
        ] as unknown[],
      },
    ],
    limits: {
      turns: 2000,
      rounds: 100,
      queuedEvents: 1000,
      pendingMessages: 1000,
      traceBytes: 1048576,
    },
    untilMs: 110,
    end: { pendingFutureTasks: "forbid", pendingMessages: 0, heldFrames: 0 },
  };
  return { document, configuration };
}
export async function files(
  input = fixture(),
  transform = (value: string) => value,
) {
  const directory = await mkdtemp(join(tmpdir(), "zooglass-document-"));
  const wire = JSON.stringify(input.configuration);
  input.document.runtime.sha256 = createHash("sha256")
    .update(wire)
    .digest("hex");
  const path = join(directory, "scenario.json");
  await writeFile(join(directory, "runtime.json"), wire);
  await writeFile(path, transform(JSON.stringify(input.document)));
  return { path, close: () => rm(directory, { recursive: true, force: true }) };
}
