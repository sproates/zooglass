import { isDeepStrictEqual } from "node:util";
import {
  BenchmarkLimit,
  ObservationLog,
  type BenchmarkPhase,
  type BenchmarkPublication,
  type Observation,
  type OracleOptions,
  type SubmissionTiming,
} from "./model.js";

type Message = Record<string, unknown>;
const record = (value: unknown): Message =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Message)
    : {};
const phases = ["seed", "warmup", "measurement"] as const;
const counts = () => ({
  submitted: 0,
  acknowledged: 0,
  expectedUpdates: 0,
  validUpdates: 0,
  completedFanout: 0,
});

interface Pending {
  publication: BenchmarkPublication;
  timing: SubmissionTiming;
  acknowledged: boolean;
  deliveries: Set<number>;
  version?: number;
}

interface Stream {
  first: number;
  last: number;
  // Inclusive last sequence submitted in each phase. Submissions are contiguous per entity.
  phaseEnds: Partial<Record<BenchmarkPhase, number>>;
  pending: Map<number, Pending>;
  lastDelivered: Map<number, number>;
}

function validVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function identity(publication: BenchmarkPublication) {
  return {
    sourceId: publication.sourceId,
    epoch: publication.epoch,
    sourceEntityId: publication.sourceEntityId,
  };
}

function snapshotMatches(
  raw: Message,
  viewId: string,
  publication: BenchmarkPublication,
) {
  return (
    raw.viewId === viewId &&
    raw.entityId === publication.sourceEntityId &&
    validVersion(raw.version) &&
    isDeepStrictEqual(raw.provenance, { value: identity(publication) }) &&
    isDeepStrictEqual(raw.publicationSequences, {
      value: [publication.publicationSequence],
    }) &&
    isDeepStrictEqual(raw.data, { value: publication.payload })
  );
}

function timestamp(atMs: number) {
  if (!Number.isFinite(atMs) || atMs < 0) {
    throw new Error("Invalid benchmark timestamp");
  }
}

/** Oracle for the fixed one-source, single latest-by-sequence field benchmark. */
export class BenchmarkOracle {
  readonly #views: string[];
  readonly #viewers: string[];
  readonly #maxPending: number;
  readonly #log: ObservationLog;
  readonly #storage: "memory" | "sqlite";
  readonly #streams = new Map<string, Stream>();
  readonly #phases = {
    seed: counts(),
    warmup: counts(),
    measurement: counts(),
  };
  readonly #faults: Record<string, number> = {};
  #pendingCount = 0;

  constructor(options: OracleOptions) {
    this.#views = [...options.viewIds];
    this.#viewers = [...options.viewerIds];
    this.#storage = options.storage;
    this.#maxPending = options.maxPending ?? 10000;
    if (
      !["memory", "sqlite"].includes(this.#storage) ||
      !Number.isSafeInteger(this.#maxPending) ||
      this.#maxPending < 1 ||
      this.#maxPending > 10000 ||
      !this.#views.length ||
      this.#views.length > 4 ||
      !this.#viewers.length ||
      this.#viewers.length > 8 ||
      new Set(this.#views).size !== this.#views.length ||
      new Set(this.#viewers).size !== this.#viewers.length
    ) {
      throw new Error("Invalid benchmark oracle configuration");
    }
    this.#log = new ObservationLog(
      options.maxEntries ?? 2_000_000,
      options.maxBytes ?? 512 * 1024 * 1024,
    );
  }

  get pendingCount() {
    return this.#pendingCount;
  }

  register(
    publication: BenchmarkPublication,
    timing: Omit<SubmissionTiming, "submittedMs"> & {
      submittedMs: number | (() => number);
    },
  ) {
    timestamp(timing.plannedMs);
    if (
      !validVersion(publication.publicationSequence) ||
      publication.sourceId !== "benchmark" ||
      publication.epoch !== "run" ||
      publication.type !== "value" ||
      !phases.includes(timing.phase)
    ) {
      throw new Error("Invalid generated benchmark publication or timing");
    }
    if (this.#pendingCount >= this.#maxPending) {
      throw new BenchmarkLimit("Benchmark pending publication limit reached");
    }
    const { sourceEntityId: entityId, publicationSequence: sequence } =
      publication;
    let stream = this.#streams.get(entityId);
    if (
      stream &&
      (sequence !== stream.last + 1 ||
        phases
          .slice(phases.indexOf(timing.phase) + 1)
          .some((phase) => stream!.phaseEnds[phase] !== undefined))
    ) {
      throw new Error(
        "Benchmark publications must be contiguous and phase-ordered per entity",
      );
    }
    if (!stream && this.#streams.size >= 10000) {
      throw new BenchmarkLimit("Benchmark resident stream limit reached");
    }
    const observation = {
      kind: "submit" as const,
      phase: timing.phase,
      entityId,
      sequence,
      plannedMs: timing.plannedMs,
      atMs: 0,
    };
    // Complete validation and reserve space for any finite timestamp before calling send.
    if (typeof timing.submittedMs === "function") {
      this.#log.requireRoom(
        Buffer.byteLength(JSON.stringify(observation)) + 32,
      );
    }
    const submittedMs =
      typeof timing.submittedMs === "function"
        ? timing.submittedMs()
        : timing.submittedMs;
    timestamp(submittedMs);
    if (submittedMs < timing.plannedMs) {
      throw new Error("Invalid generated benchmark submission time");
    }
    this.#log.append({ ...observation, atMs: submittedMs });
    if (!stream) {
      stream = {
        first: sequence,
        last: sequence,
        phaseEnds: {},
        pending: new Map(),
        lastDelivered: new Map(),
      };
      this.#streams.set(entityId, stream);
    }
    stream.last = sequence;
    stream.phaseEnds[timing.phase] = sequence;
    stream.pending.set(sequence, {
      publication: { ...publication, payload: { ...publication.payload } },
      timing: { phase: timing.phase, plannedMs: timing.plannedMs, submittedMs },
      acknowledged: false,
      deliveries: new Set(),
    });
    this.#pendingCount++;
    const count = this.#phases[timing.phase];
    count.submitted++;
    count.expectedUpdates += this.expectedFanout(timing.phase);
    if (timing.phase === "seed") {
      count.completedFanout++;
    }
  }

  private expectedFanout(phase: BenchmarkPhase) {
    return phase === "seed" ? 0 : this.#views.length * this.#viewers.length;
  }

  private fail(
    fault: string,
    observation: Omit<Observation, "kind" | "fault">,
  ): never {
    this.#faults[fault] = (this.#faults[fault] ?? 0) + 1;
    this.#log.append({ kind: "fault", ...observation, fault });
    throw new Error(`Benchmark oracle: ${fault}`);
  }

  private locate(
    kind: "receipt" | "update",
    source: Message,
    sequence: unknown,
    atMs: number,
    route: { viewerId?: string; viewId?: string } = {},
  ) {
    timestamp(atMs);
    const entityId =
      typeof source.sourceEntityId === "string"
        ? source.sourceEntityId
        : undefined;
    const stream =
      entityId !== undefined ? this.#streams.get(entityId) : undefined;
    const observation = {
      atMs,
      ...route,
      entityId,
      sequence: validVersion(sequence) ? sequence : undefined,
    };
    if (
      !stream ||
      source.sourceId !== "benchmark" ||
      source.epoch !== "run" ||
      !validVersion(sequence) ||
      sequence < stream.first ||
      sequence > stream.last
    ) {
      return this.fail(`unexpected-${kind}`, observation);
    }
    const pending = stream.pending.get(sequence);
    if (!pending) {
      const phase = phases.find(
        (phase) => sequence <= (stream.phaseEnds[phase] ?? 0),
      )!;
      return this.fail(
        phase === "seed" && kind === "update"
          ? "unexpected-update"
          : `duplicate-${kind}`,
        { ...observation, phase },
      );
    }
    const phase = pending.timing.phase;
    if (atMs < pending.timing.submittedMs) {
      return this.fail("callback-before-submission", { ...observation, phase });
    }
    return { stream, pending, phase, observation: { ...observation, phase } };
  }

  private retireIfComplete(stream: Stream, pending: Pending) {
    if (
      pending.acknowledged &&
      pending.deliveries.size === this.expectedFanout(pending.timing.phase)
    ) {
      stream.pending.delete(pending.publication.publicationSequence);
      this.#pendingCount--;
    }
  }

  recordReceipt(raw: unknown, atMs: number) {
    const receipt = record(raw);
    const source = record(receipt.stream);
    const { stream, pending, phase, observation } = this.locate(
      "receipt",
      source,
      receipt.publicationSequence,
      atMs,
    );
    if (pending.acknowledged) {
      this.fail("duplicate-receipt", observation);
    }
    if (
      receipt.status === "rejected" ||
      receipt.status === "failed" ||
      receipt.status === "duplicate"
    ) {
      this.fail(`${receipt.status}-publication`, observation);
    }
    const expectedTargets = this.#views.map((viewId) => ({
      viewId,
      entityId: pending.publication.sourceEntityId,
      status: "accepted",
      reason: null,
      changedFields: ["value"],
      fields: [
        { field: "value", status: "accepted", reason: null, changed: true },
      ],
    }));
    if (
      receipt.status !==
        (this.#storage === "memory" ? "applied" : "committed") ||
      receipt.reason !== this.#storage ||
      !validVersion(receipt.version) ||
      (pending.version !== undefined && receipt.version !== pending.version) ||
      !isDeepStrictEqual(source, identity(pending.publication)) ||
      !isDeepStrictEqual(receipt.changedViews, this.#views) ||
      !isDeepStrictEqual(receipt.targets, expectedTargets)
    ) {
      this.fail("mismatched-receipt", observation);
    }
    this.#log.append({
      kind: "receipt",
      ...observation,
      version: receipt.version,
    });
    pending.version = receipt.version;
    pending.acknowledged = true;
    this.#phases[phase].acknowledged++;
    this.retireIfComplete(stream, pending);
  }

  recordUpdate(viewerId: string, raw: unknown, atMs: number) {
    const frame = record(raw);
    const viewId = typeof frame.viewId === "string" ? frame.viewId : undefined;
    const viewer = this.#viewers.indexOf(viewerId);
    const view = viewId === undefined ? -1 : this.#views.indexOf(viewId);
    if (viewer < 0 || view < 0 || frame.type !== "view-update") {
      this.fail("unexpected-update", { atMs, viewerId, viewId });
    }
    const source = record(record(frame.provenance).value);
    const sequences = record(frame.publicationSequences).value;
    const sequence =
      Array.isArray(sequences) && sequences.length === 1
        ? sequences[0]
        : undefined;
    const { stream, pending, phase, observation } = this.locate(
      "update",
      source,
      sequence,
      atMs,
      { viewerId, viewId },
    );
    const lane = viewer * this.#views.length + view;
    if (phase === "seed") {
      this.fail("unexpected-update", observation);
    }
    if (pending.deliveries.has(lane)) {
      this.fail("duplicate-update", observation);
    }
    if (
      !snapshotMatches(frame, this.#views[view], pending.publication) ||
      !validVersion(frame.version) ||
      (pending.version !== undefined && pending.version !== frame.version)
    ) {
      this.fail("mismatched-update", observation);
    }
    const order = pending.publication.publicationSequence;
    if (order <= (stream.lastDelivered.get(lane) ?? 0)) {
      this.fail("out-of-order-update", observation);
    }
    this.#log.append({
      kind: "update",
      ...observation,
      version: frame.version,
    });
    pending.version = frame.version;
    stream.lastDelivered.set(lane, order);
    pending.deliveries.add(lane);
    const count = this.#phases[phase];
    count.validUpdates++;
    if (pending.deliveries.size === this.expectedFanout(phase)) {
      count.completedFanout++;
    }
    this.retireIfComplete(stream, pending);
  }

  verifySnapshot(
    viewId: string,
    publication: BenchmarkPublication,
    raw: unknown,
  ) {
    if (
      !this.#views.includes(viewId) ||
      !snapshotMatches(record(raw), viewId, publication)
    ) {
      this.#faults["mismatched-snapshot"] =
        (this.#faults["mismatched-snapshot"] ?? 0) + 1;
      throw new Error(
        `Benchmark oracle: mismatched-snapshot for ${viewId}/${publication.sourceEntityId}`,
      );
    }
  }

  summary() {
    const summaryFor = (phase: BenchmarkPhase) => {
      const count = this.#phases[phase];
      return {
        ...count,
        missingReceipts: count.submitted - count.acknowledged,
        missingUpdates: count.expectedUpdates - count.validUpdates,
        pendingFanout: count.submitted - count.completedFanout,
      };
    };
    return {
      phases: {
        seed: summaryFor("seed"),
        warmup: summaryFor("warmup"),
        measurement: summaryFor("measurement"),
      },
      pending: this.pendingCount,
      faults: { ...this.#faults },
      rawEntries: this.#log.entries,
      encodedBytes: this.#log.encodedBytes,
      allocatedBytes: this.#log.allocatedBytes,
    };
  }

  rawChunks() {
    return this.#log.chunks();
  }
}
