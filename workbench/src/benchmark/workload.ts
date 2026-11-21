import type { RuntimeConfiguration } from "../service/runtime-contract.js";

export interface WorkloadOptions {
  storage: "memory" | "sqlite";
  residentEntities: number;
  hotEntities: number;
  sourceSockets: number;
  views: number;
  viewers: number;
  payloadBytes: number;
}
export const baseline: WorkloadOptions = {
  storage: "memory",
  residentEntities: 100,
  hotEntities: 16,
  sourceSockets: 1,
  views: 1,
  viewers: 1,
  payloadBytes: 256,
};

/** Values originate here, never from service receipts or snapshots. */
export class Workload {
  readonly configuration: RuntimeConfiguration;
  readonly viewIds: string[];
  readonly viewerIds: string[];
  private readonly sequences: number[];
  constructor(readonly options: WorkloadOptions) {
    if (!["memory", "sqlite"].includes(options.storage))
      throw new Error("Invalid storage");
    for (const key of [
      "residentEntities",
      "hotEntities",
      "sourceSockets",
      "views",
      "viewers",
      "payloadBytes",
    ] as const) {
      if (!Number.isSafeInteger(options[key]) || options[key] < 1)
        throw new Error(`Invalid ${key}`);
    }
    if (
      options.residentEntities > 10000 ||
      options.hotEntities > options.residentEntities ||
      options.hotEntities > 16 ||
      options.sourceSockets > 8 ||
      options.hotEntities % options.sourceSockets ||
      options.views > 4 ||
      options.viewers > 8 ||
      options.payloadBytes < 128 ||
      options.payloadBytes > 4096
    )
      throw new Error("Workload exceeds benchmark bounds");
    this.viewIds = Array.from({ length: options.views }, (_, i) => `view-${i}`);
    this.viewerIds = Array.from(
      { length: options.viewers },
      (_, i) => `viewer-${i}`,
    );
    this.sequences = Array(options.residentEntities).fill(0);
    this.configuration = {
      contractVersion: 2,
      storage: options.storage,
      maxStreams: 10000,
      identityWindow: 64,
      maxHistoryEntries: 1000,
      sources: [{ id: "benchmark", epoch: "run" }],
      views: this.viewIds.map((id) => ({
        id,
        fields: {
          value: {
            sourceId: "benchmark",
            type: "value",
            mode: "latestBySequence",
          },
        },
      })),
    };
  }
  entity(index: number) {
    return `entity-${index}`;
  }
  publication(index: number) {
    if (!Number.isInteger(index) || index < 0 || index >= this.sequences.length)
      throw new Error("Invalid entity index");
    const sequence = ++this.sequences[index];
    const payload = { marker: `${index}:${sequence}`, padding: "" };
    payload.padding = "x".repeat(
      this.options.payloadBytes - Buffer.byteLength(JSON.stringify(payload)),
    );
    return {
      sourceId: "benchmark",
      epoch: "run",
      sourceEntityId: this.entity(index),
      publicationSequence: sequence,
      type: "value",
      payload,
    };
  }
}
