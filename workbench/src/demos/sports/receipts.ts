import type { PublicationReceipt } from "../../execution/publication-receipt.js";
import { factFields, sportsViews } from "./configuration.js";
import type { SportsAction } from "./timeline.js";

export function checkSportsReceipt(
  action: Extract<SportsAction, { kind: "publish" }>,
  receipt: PublicationReceipt,
) {
  const fail = () => {
    throw new Error(`Unexpected Sports receipt: ${JSON.stringify(receipt)}`);
  };
  if (action.event.expectedRejection) {
    if (
      receipt.status !== "rejected" ||
      receipt.reason !== action.event.expectedRejection
    )
      fail();
    return;
  }
  if (
    receipt.status !== (action.duplicate ? "duplicate" : "committed") ||
    receipt.reason !== (action.duplicate ? "alreadyCommitted" : "sqlite")
  )
    fail();
  const views =
    action.event.sourceId === "bookmaker" ? ["match-market"] : [...sportsViews];
  if (receipt.targets?.length !== views.length) fail();
  for (const view of views) {
    const target = receipt.targets?.find((target) => target.viewId === view);
    if (!target || target.entityId !== action.event.entityId) {
      fail();
      return;
    }
    const reason =
      action.outcome === "outside"
        ? "factOutsideRetention"
        : action.outcome !== undefined &&
            action.outcome !== "create" &&
            view === "first-reported"
          ? "factImmutable"
          : action.outcome === "obsolete"
            ? "obsoleteRevision"
            : null;
    if (
      target.status !== (reason ? "rejected" : "accepted") ||
      target.reason !== reason
    )
      fail();
    if (action.event.fact) {
      const side = action.event.type.startsWith("home") ? "home" : "away";
      const expected = factFields(view as (typeof sportsViews)[number]).filter(
        (field) => field.startsWith(side),
      );
      if (target.fields?.length !== expected.length) fail();
      for (const field of expected) {
        const outcome = target.fields?.find((item) => item.field === field);
        if (
          !outcome ||
          outcome.status !== (reason ? "rejected" : "accepted") ||
          outcome.reason !== reason ||
          (reason !== null && outcome.changed !== false)
        )
          fail();
      }
    }
  }
}
