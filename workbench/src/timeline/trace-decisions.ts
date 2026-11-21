import { decisionEnvelope } from "./decision-contract.js";
import { encodeJson } from "./json.js";
import type { TraceEvent } from "./trace-generations.js";
import { invalid, object } from "./validation.js";

export type RecordedDecision = {
  event: TraceEvent;
  receipt: TraceEvent;
  attempt: TraceEvent;
  original?: string;
};

/** Exactly one current-attempt decision per receipt; original applications are lineage-bound. */
export class TraceDecisions {
  readonly entries: RecordedDecision[] = [];
  private readonly attempts = new Map<string, TraceEvent>();
  private readonly receipts = new Map<string, TraceEvent>();
  private readonly decisions = new Set<string>();
  private readonly applications = new Map<string, string[]>();

  constructor(private readonly storage?: "memory" | "sqlite") {}

  accept(event: TraceEvent, path: string) {
    if (
      event.kind === "action" &&
      ["source-send", "source-retry"].includes(String(event.data.actionKind))
    )
      this.attempts.set(event.id, event);
    if (event.kind !== "receipt" && event.kind !== "publication-decision")
      return;
    const attempt = event.parent ? this.attempts.get(event.parent) : undefined;
    if (
      !attempt ||
      attempt.actor !== event.actor ||
      attempt.runtimeGeneration !== event.runtimeGeneration ||
      attempt.connectionGeneration !== event.connectionGeneration ||
      attempt.key.some((value, index) => value !== event.key[index])
    )
      invalid(
        path,
        "publication result must identify its live source attempt at the same agenda key",
      );
    if (event.kind === "receipt") {
      if (this.receipts.has(attempt.id))
        invalid(path, "multiple receipts for publication attempt");
      this.receipts.set(attempt.id, event);
      return;
    }
    const receipt = this.receipts.get(attempt.id);
    if (!receipt || this.decisions.has(attempt.id))
      invalid(path, "decision requires exactly one preceding receipt");
    this.decisions.add(attempt.id);
    const envelope = decisionEnvelope(event.data.envelope, path);
    const outcome = object(receipt.data.envelope, path);
    if (envelope.availability === "unavailable") {
      const failure = envelope.reason === "processingFailure";
      if (
        outcome.status !== (failure ? "failed" : "rejected") ||
        outcome.reason !== envelope.reason ||
        outcome.version !== null
      )
        invalid(
          path,
          "unavailable decision requires matching failed processing or malformed receipt",
        );
      if (
        !failure &&
        (outcome.stream !== null ||
          outcome.publicationSequence !== null ||
          encodeJson(outcome.targets) !== "[]" ||
          encodeJson(outcome.changedViews) !== "[]")
      )
        invalid(
          path,
          "malformed envelope cannot have publication identity or targets",
        );
      this.entries.push({ event, receipt, attempt });
      return;
    }
    const decision = object(envelope.decision, path);
    for (const field of [
      "stream",
      "publicationSequence",
      "status",
      "reason",
      "version",
    ])
      if (encodeJson(decision[field]) !== encodeJson(outcome[field]))
        invalid(path, `decision differs from receipt ${field}`);
    const key = encodeJson([
      this.storage === "sqlite"
        ? null
        : event.runtimeGeneration === null
          ? null
          : String(event.runtimeGeneration),
      decision.stream,
      decision.publicationSequence,
      decision.version,
    ]);
    const prior = this.applications.get(key) ?? [];
    const original =
      decision.status === "duplicate" && prior.length === 1
        ? prior[0]
        : undefined;
    this.entries.push({
      event,
      receipt,
      attempt,
      ...(original ? { original } : {}),
    });
    if (decision.installed) this.applications.set(key, [...prior, event.id]);
  }

  finish(outcome: string) {
    for (const id of this.receipts.keys())
      if (!this.decisions.has(id))
        invalid("trace", "missing publication decision for receipt");
    if (outcome === "passed" || outcome === "assertion-failed")
      for (const id of this.attempts.keys())
        if (!this.receipts.has(id))
          invalid("trace", "missing publication processing result");
  }
}
