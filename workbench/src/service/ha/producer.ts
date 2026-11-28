import { Decimal, parseJson } from "../../json/lossless.js";
import { Ownership } from "./ownership.js";
import { Episode, terminal, type RecoveryBounds } from "./recovery.js";
import {
  byteBound,
  trustedOrigins,
  type Transport,
  type Channel,
} from "./transport.js";
import {
  decode,
  object,
  ProtocolFailure,
  runtimeIncarnation,
  text,
  type ObjectValue,
} from "./protocol.js";

export interface RetainedPublication {
  readonly bytes: string;
  readonly incarnation?: string;
}
export type PublicationResult =
  | { status: "resolved"; receipt: ObjectValue }
  | {
      status: "unresolved";
      publication: RetainedPublication;
      reason: string;
      receipt?: ObjectValue;
    };
export interface ProducerSettings extends RecoveryBounds {
  origins: readonly string[];
  transport: Transport;
  ownership: Ownership;
  maxBytes: number;
  localOperator?: boolean;
  retained?: RetainedPublication;
}
function identity(
  raw: string,
  limit: number,
): { stream: string[]; sequence: string } {
  if (Buffer.byteLength(raw) > limit) {
    throw new ProtocolFailure("Publication exceeds byte limit");
  }
  const p = object(parseJson(raw, limit));
  const sequence = p.publicationSequence;
  if (
    !(sequence instanceof Decimal) ||
    !/^[1-9][0-9]*$/.test(sequence.text) ||
    BigInt(sequence.text) > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw new ProtocolFailure("Invalid publication identity");
  }
  text(p.type);
  object(p.payload);
  return {
    stream: [text(p.sourceId), text(p.epoch), text(p.sourceEntityId)],
    sequence: sequence.text,
  };
}

/** One retained publication; failure never regenerates its identity or silently changes its incarnation. */
export class HaProducer {
  private readonly origins: string[];
  private readonly limit: number;
  private readonly stop = new AbortController();
  private pending?: RetainedPublication;
  private busy = false;
  private readonly settings: ProducerSettings;
  constructor(settings: ProducerSettings) {
    this.settings = Object.freeze({
      ...settings,
      origins: Object.freeze([...settings.origins]),
    });
    settings = this.settings;
    this.origins = trustedOrigins(settings.origins, settings.localOperator);
    this.limit = byteBound(settings.maxBytes);
    if (settings.retained) {
      identity(settings.retained.bytes, this.limit);
      if (settings.retained.incarnation !== undefined)
        runtimeIncarnation(settings.retained.incarnation);
      if (
        settings.retained.incarnation !== undefined &&
        settings.ownership.incarnation !== settings.retained.incarnation
      ) {
        throw new ProtocolFailure(
          "Restored publication requires a matching Ownership incarnation pin",
        );
      }
      this.pending = Object.freeze({ ...settings.retained });
    }
    new Episode(settings); // Validate finite bounds before accepting work.
  }
  get retained(): RetainedPublication | undefined {
    return this.pending;
  }
  publish(bytes: string): Promise<PublicationResult> {
    this.settings.ownership.assertAvailable();
    if (this.pending || this.busy || this.stop.signal.aborted) {
      throw new Error("Producer is closed or has an unresolved publication");
    }
    identity(bytes, this.limit);
    this.pending = Object.freeze({
      bytes,
      incarnation: this.settings.ownership.incarnation,
    });
    return this.retry();
  }
  async retry(): Promise<PublicationResult> {
    if (!this.pending || this.busy || this.stop.signal.aborted) {
      throw new Error("No available retained operation");
    }
    this.busy = true;
    let retained = this.pending;
    const episode = new Episode(this.settings),
      expected = identity(this.pending.bytes, this.limit);
    const signal = AbortSignal.any([
      this.stop.signal,
      this.settings.ownership.signal,
    ]);
    let attempt = 0,
      last = this.settings.ownership.signal.aborted
        ? "Runtime incarnation changed; explicit reconciliation is required"
        : "Recovery deadline exhausted";
    try {
      while (episode.remaining() && !signal.aborted) {
        let channel: Channel | undefined;
        let detach = () => {};
        try {
          channel = await this.settings.transport.connect(
            this.origins[attempt % this.origins.length],
            "/events",
            episode.signal(signal),
          );
          const hello = decode(
            await channel.next(episode.signal(signal)),
            this.limit,
          );
          if ("error" in hello || hello.kind !== "hello") {
            throw new ProtocolFailure("Expected producer hello");
          }
          if (
            retained.incarnation &&
            retained.incarnation !== hello.incarnation
          ) {
            this.settings.ownership.rejectIncarnation();
          }
          if (!this.settings.ownership.observe(hello)) {
            throw new Error("Former owner refused");
          }
          retained = Object.freeze({
            bytes: retained.bytes,
            incarnation: hello.incarnation,
          });
          this.pending = retained;
          const obsolete = new AbortController();
          detach = this.settings.ownership.listen(() => {
            if (this.settings.ownership.generation > hello.generation) {
              obsolete.abort(new Error("Source owner superseded"));
              channel?.close();
            }
          });
          channel.send(retained.bytes);
          const rawReceipt = await channel.next(
            episode.signal(AbortSignal.any([signal, obsolete.signal])),
          );
          obsolete.signal.throwIfAborted();
          signal.throwIfAborted();
          const receipt = decode(rawReceipt, this.limit);
          if (
            !("error" in receipt) &&
            receipt.incarnation !== hello.incarnation
          ) {
            this.settings.ownership.rejectIncarnation();
          }
          if (
            "error" in receipt ||
            receipt.kind !== "receipt" ||
            receipt.generation !== hello.generation ||
            receipt.incarnation !== hello.incarnation
          ) {
            throw new ProtocolFailure("Unexpected receipt context");
          }
          if (!this.settings.ownership.observe(receipt)) {
            throw new Error("Stale receipt");
          }
          const p = receipt.payload,
            stream = object(p.stream),
            sequence = p.publicationSequence;
          if (
            [
              text(stream.sourceId),
              text(stream.epoch),
              text(stream.sourceEntityId),
            ].some((part, i) => part !== expected.stream[i]) ||
            !(sequence instanceof Decimal) ||
            sequence.text !== expected.sequence
          ) {
            throw new ProtocolFailure(
              "Receipt identity does not match retained publication",
            );
          }
          if (
            p.reason === "identityConflict" ||
            p.reason === "outsideRetention"
          ) {
            return {
              status: "unresolved",
              publication: retained,
              reason: text(p.reason),
              receipt: p,
            };
          }
          if (p.status === "committed" || p.status === "duplicate") {
            if (
              p.reason !==
                (p.status === "committed"
                  ? "postgresql"
                  : "alreadyCommitted") ||
              !(p.version instanceof Decimal) ||
              BigInt(p.version.text) < 1n ||
              BigInt(p.version.text) > receipt.contentRevision
            ) {
              throw new ProtocolFailure(
                "Receipt does not prove the claimed durable outcome",
              );
            }
          }
          this.pending = undefined;
          return { status: "resolved", receipt: p };
        } catch (error) {
          last = error instanceof Error ? error.message : "Publication failed";
          if (terminal(error) || signal.aborted) {
            break;
          }
        } finally {
          detach();
          channel?.close();
        }
        try {
          await episode.backoff(attempt++, signal);
        } catch {
          break;
        }
      }
      return { status: "unresolved", publication: retained, reason: last };
    } finally {
      this.busy = false;
    }
  }
  /** Only the application can decide that the old operation has been reconciled. */
  discardAfterReconciliation(): void {
    if (this.busy) {
      throw new Error("Cannot reconcile an operation in progress");
    }
    this.pending = undefined;
  }
  close(): void {
    this.stop.abort(new Error("Producer cancelled"));
  }
}
