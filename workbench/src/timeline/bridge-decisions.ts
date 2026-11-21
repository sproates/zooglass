import type { Response } from "./host-protocol.js";

/** Reject unsolicited diagnostics and incomplete ingress replies before acknowledging a turn. */
export function validateDecisionEffects(
  response: Response,
  operation: Record<string, unknown>,
  enabled: boolean,
): boolean {
  const decisions = response.effects.filter(
    (effect) => effect.kind === "publication-decision",
  );
  if (!enabled || operation.op !== "ingress") {
    if (decisions.length)
      throw new Error("Unexpected publication decision effect");
  } else {
    const receipts = response.effects.filter(
      (effect) => effect.kind === "receipt",
    );
    if (
      decisions.length !== 1 ||
      receipts.length !== 1 ||
      decisions[0].session !== operation.session ||
      receipts[0].session !== operation.session
    )
      throw new Error(
        "Explained ingress requires one receipt and decision for its session",
      );
  }
  return operation.op === "initialize-document"
    ? operation.publicationDecisions === true
    : enabled;
}
