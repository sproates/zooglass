export type BenchmarkPhase = "seed" | "warmup" | "measurement";

export interface BenchmarkPublication {
  sourceId: string;
  epoch: string;
  sourceEntityId: string;
  publicationSequence: number;
  type: string;
  payload: { marker: string; padding: string };
}

export interface SubmissionTiming {
  phase: BenchmarkPhase;
  plannedMs: number;
  submittedMs: number;
}

export interface OracleOptions {
  storage: "memory" | "sqlite";
  viewIds: readonly string[];
  viewerIds: readonly string[];
  maxPending?: number;
  maxEntries?: number;
  maxBytes?: number;
}

export class BenchmarkLimit extends Error {}

export interface Observation {
  kind: "submit" | "receipt" | "update" | "fault";
  phase?: BenchmarkPhase;
  entityId?: string;
  sequence?: number;
  atMs: number;
  plannedMs?: number;
  viewerId?: string;
  viewId?: string;
  version?: number;
  fault?: string;
}

/** Append JSONL in bounded blocks. The driver writes the occupied slices after measurement. */
export class ObservationLog {
  readonly #blocks: Buffer[] = [];
  #usedInLast = 0;
  encodedBytes = 0;
  allocatedBytes = 0;
  entries = 0;

  constructor(
    readonly maxEntries: number,
    readonly maxBytes: number,
  ) {
    if (
      !Number.isSafeInteger(maxEntries) ||
      maxEntries < 1 ||
      maxEntries > 2_000_000 ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1 ||
      maxBytes > 512 * 1024 * 1024
    ) {
      throw new Error("Invalid benchmark observation limits");
    }
  }

  requireRoom(length: number) {
    if (
      this.entries >= this.maxEntries ||
      this.encodedBytes + length > this.maxBytes
    ) {
      throw new BenchmarkLimit("Benchmark observation limit reached");
    }
  }

  append(observation: Observation) {
    const line = JSON.stringify(observation) + "\n";
    const length = Buffer.byteLength(line);
    this.requireRoom(length);
    let block = this.#blocks.at(-1);
    if (!block || block.length - this.#usedInLast < length) {
      if (block) {
        this.#blocks[this.#blocks.length - 1] = block.subarray(
          0,
          this.#usedInLast,
        );
      }
      block = Buffer.allocUnsafeSlow(Math.max(64 * 1024, length));
      this.#blocks.push(block);
      this.allocatedBytes += block.byteLength;
      this.#usedInLast = 0;
    }
    this.#usedInLast += block.write(line, this.#usedInLast);
    this.entries++;
    this.encodedBytes += length;
  }

  *chunks(): Iterable<Buffer> {
    for (const [index, block] of this.#blocks.entries()) {
      yield index === this.#blocks.length - 1
        ? block.subarray(0, this.#usedInLast)
        : block;
    }
  }
}
