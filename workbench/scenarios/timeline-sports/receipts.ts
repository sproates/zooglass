/** Authored story dispositions; helpers expand declared field outcomes into complete wire receipts. */
import {
  views,
  type PublicationInput,
  type ProgressInput,
  type RetirementInput,
} from "./inputs.js";
import { versions } from "./versions.js";
type Disposition =
  | "metadata"
  | "baseline"
  | "create"
  | "correct"
  | "withdraw"
  | "obsolete"
  | "unknown"
  | "duplicate-withdraw"
  | "duplicate-create"
  | "outside"
  | "market";
const dispositions: Record<string, Disposition> = {
  metadata: "metadata",
  "second-half": "metadata",
  finished: "metadata",
  "home-baseline": "baseline",
  "both-baselines": "baseline",
  "first-goal": "create",
  "unknown-fact": "unknown",
  "delayed-create": "create",
  "corrected-scorer": "correct",
  withdrawal: "withdraw",
  "obsolete-revision": "obsolete",
  duplicate: "duplicate-withdraw",
  "behind-market": "market",
  "current-market": "market",
  "market-refreshed": "market",
  "away-goal": "create",
  "home-goals-withdrawn": "withdraw",
  "all-goals-withdrawn": "withdraw",
  "later-away-goal": "create",
  "retired-duplicate": "duplicate-create",
  "outside-retention": "outside",
};
export function receipt(input: PublicationInput) {
  const body = input.body,
    disposition =
      body.sourceId === "bookmaker" ? "market" : dispositions[input.name];
  if (!disposition) throw new Error(`Missing authored disposition ${input.id}`);
  const duplicate = disposition.startsWith("duplicate"),
    unknown = disposition === "unknown";
  const home = body.type.startsWith("home"),
    side = home ? "home" : "away";
  const targets = unknown
    ? [
        {
          viewId: "match-market",
          entityId: input.entityId,
          status: "rejected",
          reason: "unknownFact",
          changedFields: [],
          fields: [
            {
              field: "homeGoals",
              status: "rejected",
              reason: "unknownFact",
              changed: false,
            },
          ],
        },
      ]
    : (disposition === "market" ? [views[0]] : views).map((viewId) => {
        const first = viewId === "first-reported";
        const immutable =
          first &&
          ["correct", "withdraw", "obsolete", "duplicate-withdraw"].includes(
            disposition,
          );
        const reason =
          disposition === "outside"
            ? "factOutsideRetention"
            : immutable
              ? "factImmutable"
              : disposition === "obsolete"
                ? "obsoleteRevision"
                : null;
        const fields =
          disposition === "metadata"
            ? ["match"]
            : disposition === "market"
              ? ["market"]
              : viewId === "scoreboard"
                ? [`${side}Score`]
                : [`${side}Goals`, `${side}Score`];
        const changed = (field: string) =>
          reason !== null
            ? false
            : disposition === "correct"
              ? field.endsWith("Goals")
              : disposition === "baseline" && input.cycle === 2
                ? field.endsWith("Goals")
                : true;
        const changedFields = fields.filter(changed);
        return {
          viewId,
          entityId: input.entityId,
          status: reason ? "rejected" : "accepted",
          reason,
          changedFields,
          fields: fields.map((field) => ({
            field,
            status: reason ? "rejected" : "accepted",
            reason,
            changed: changed(field),
          })),
        };
      });
  return {
    status: unknown ? "rejected" : duplicate ? "duplicate" : "committed",
    reason: unknown ? "unknownFact" : duplicate ? "alreadyCommitted" : "sqlite",
    stream: {
      sourceId: body.sourceId,
      epoch: "run",
      sourceEntityId: input.entityId,
    },
    publicationSequence: body.publicationSequence,
    version: versions[input.id],
    changedViews:
      unknown || duplicate ? [] : disposition === "market" ? [views[0]] : views,
    targets,
  };
}
export function progressReceipt(input: ProgressInput) {
  const { throughSequence, ...stream } = input.control;
  return {
    kind: "watermark",
    status: "committed",
    reason: "sqlite",
    stream,
    throughSequence,
    version: versions[input.id],
    changedViews: ["match-market"],
  };
}
export function retirementReceipt(input: RetirementInput) {
  const control = {
    ...input.control,
    fields: [...input.control.fields].sort(),
  };
  return {
    kind: "factRetirement",
    status: "committed",
    reason: null,
    control,
    version: versions[input.id],
    floors: Object.fromEntries(
      control.fields.map((field) => [field, control.minimumBirthSequence]),
    ),
    changedViews: [control.viewId],
  };
}
