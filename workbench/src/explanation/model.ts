import { Decimal, type Json } from "../timeline/json.js";
import type { TraceEvent } from "../timeline/trace-generations.js";
import { list, object, text } from "../timeline/validation.js";
import { explanationContext, type DecisionAssociation } from "./context.js";

export const reportLimits = { bytes: 16 * 1024 * 1024, entries: 100000 };
export type ExplanationInput = {
  profile: string;
  outcome: string;
  format: string;
  evidence: { manifestSha256: string; traceSha256: string };
  events: readonly TraceEvent[];
  publicationDecisions: readonly DecisionAssociation[];
};

const updates: Record<string, string> = {
  ARRIVAL_REPLACED: "Replaced the retained contribution on arrival.",
  SEQUENCE_MISSING: "No sequence was available for this update strategy.",
  LATEST_INITIAL: "Retained the first contribution for this field.",
  LATEST_NEWER: "Retained a contribution with a newer sequence.",
  LATEST_EQUAL: "Kept the contribution because the sequence was equal.",
  LATEST_OLDER:
    "Kept the contribution because the incoming sequence was older.",
  HISTORY_INSERTED: "Inserted the contribution into sequence history.",
  HISTORY_EXISTING: "Kept history because this sequence was already present.",
};
function counter(value: Json | undefined): string | null {
  return value instanceof Decimal ? value.text : null;
}
function identity(envelope: { [key: string]: Json }) {
  if (envelope.stream === null || envelope.stream === undefined) return null;
  const stream = object(envelope.stream, "stream");
  return {
    sourceId: text(stream.sourceId, "sourceId"),
    epoch: text(stream.epoch, "epoch"),
    sourceEntityId: text(stream.sourceEntityId, "sourceEntityId"),
    publicationSequence: counter(envelope.publicationSequence),
  };
}
function decisionDetail(association: DecisionAssociation) {
  const wrapper = object(association.event.data.envelope, "decision envelope");
  const references = {
    attemptEventId: association.attempt.id,
    receiptEventId: association.receipt.id,
  };
  if (wrapper.availability === "unavailable")
    return {
      ...references,
      availability: "unavailable" as const,
      reason: text(wrapper.reason, "reason"),
      explanation:
        wrapper.reason === "invalidEnvelope"
          ? "The envelope was rejected before publication processing; detailed strategy decisions are unavailable."
          : "Processing failed and detailed decisions are unavailable. This does not establish whether state was installed.",
    };
  const decision = object(wrapper.decision, "decision");
  const duplicate = decision.status === "duplicate";
  return {
    ...references,
    availability: "recorded" as const,
    publication: identity(decision),
    status: text(decision.status, "status"),
    reason: decision.reason === null ? null : text(decision.reason, "reason"),
    version: counter(decision.version),
    installed: decision.installed === true,
    explanation: duplicate
      ? "Recognised an existing publication identity without evaluating new field updates. Receipt targets describe historical processing."
      : decision.installed === true
        ? "Installed this publication's result. Retained changes and public value/provenance changes are recorded separately."
        : "This attempt installed no publication result. Discarded candidate field changes are not reported as installed changes.",
    ...(duplicate
      ? {
          originalDetail: association.original ? "recorded" : "unavailable",
          originalDecisionEventId: association.original ?? null,
        }
      : {}),
    targets: list(decision.targets, "targets").map((value) => {
      const target = object(value, "target");
      return {
        viewId: text(target.viewId, "viewId"),
        entityId:
          target.entityId === null ? null : text(target.entityId, "entityId"),
        fields: list(target.fields, "fields").map((value) => {
          const field = object(value, "field");
          const update = text(field.update, "update");
          return {
            field: text(field.field, "field"),
            strategy: text(field.strategy, "strategy"),
            update,
            retainedChanged: field.retainedChanged === true,
            publicChanged: field.publicChanged === true,
            explanation: updates[update],
          };
        }),
      };
    }),
  };
}
function observed(event: TraceEvent) {
  if (
    event.kind === "receipt" ||
    (event.kind === "delivered" && event.data.channel === "source-receipt")
  ) {
    const receipt = object(event.data.envelope, "receipt");
    return {
      explanation:
        event.kind === "receipt"
          ? "Produced a publication receipt; delivery is recorded separately."
          : "Delivered a publication receipt to the source.",
      publication: identity(receipt),
      status: text(receipt.status, "status"),
      reason: receipt.reason === null ? null : text(receipt.reason, "reason"),
      version: counter(receipt.version),
    };
  }
  if (event.kind === "assertion")
    return {
      explanation:
        "Recorded an assertion result. Linked observations are execution context, not proof of a business-level cause.",
      assertionId: text(event.data.assertionId, "assertionId"),
      passed: event.data.passed === true,
    };
  if (event.kind === "action")
    return {
      explanation: "Executed a declared scenario action.",
      actionId: text(event.data.actionId, "actionId"),
      actionKind: text(event.data.actionKind, "actionKind"),
    };
  if (event.kind === "runtime-initialized")
    return {
      explanation:
        "Started a runtime generation; internal storage recovery steps are not explained.",
    };
  return {
    explanation: `Recorded ${event.kind} in the execution trace; no detailed decision is inferred.`,
  };
}

/** Presentation consumes validated decisions and causal joins, never re-runs strategies. */
export function explanationModel(input: ExplanationInput, selected?: string) {
  if (input.events.length > reportLimits.entries)
    throw new Error("Explanation report entry limit exceeded");
  const context = explanationContext(
    input.events,
    input.publicationDecisions,
    selected,
  );
  const decisions = new Map(
    input.publicationDecisions.map((entry) => [entry.event.id, entry]),
  );
  const detailed = input.format === "timeline-trace/v5";
  return {
    format: "timeline-explanation/v1",
    input: input.evidence,
    recordedProfile: input.profile,
    recordedOutcome: input.outcome,
    replayStatus: "not-run" as const,
    selectedEventId: selected ?? null,
    coverage: {
      detailedRuntimeDecisions: detailed ? "recorded" : "not-recorded",
      recordedDecisionCount: input.publicationDecisions.length,
      observedReceiptCount: input.events.filter(
        (event) => event.kind === "receipt",
      ).length,
      note: detailed
        ? "Static publication decisions only. Timers, control traffic and internal recovery are not explained."
        : "This evidence format did not record detailed runtime reasons. Entries describe observed outcomes only.",
    },
    notes: [
      "Validated hashes establish internal consistency, not authenticity or fresh runtime replay.",
      "Parent and cause references describe recorded execution relationships, not proof of business-level causality.",
      "Payload values are omitted. Identifiers may still be sensitive; this report is not anonymised.",
      "Runtime counters are decimal strings to preserve their exact values.",
    ],
    entries: input.events
      .filter((event) => context.has(event.id))
      .map((event) => {
        const association = decisions.get(event.id);
        return {
          eventId: event.id,
          kind: event.kind,
          timeMs: event.timeMs,
          actor: event.actor,
          runtimeGeneration: event.runtimeGeneration,
          connectionGeneration: event.connectionGeneration,
          parentId: event.parent,
          causes: event.causes,
          ...(association
            ? { decision: decisionDetail(association) }
            : observed(event)),
        };
      }),
  };
}
export type ExplanationReport = ReturnType<typeof explanationModel>;
