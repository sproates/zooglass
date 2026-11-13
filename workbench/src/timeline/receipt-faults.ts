import { createHash } from "node:crypto";
import type { Json } from "./json.js";
import {
  choice,
  integer,
  invalid,
  list,
  object,
  reference,
  text,
  unique,
} from "./validation.js";

export const faultAlgorithm = "sha256-u32-rejection-v1";
export type ReceiptRule = {
  id: string;
  action: string;
  numerator: number;
  denominator: number;
};
export function receiptRules(doc: { [key: string]: Json }): ReceiptRule[] {
  const sourceActions = new Set(
    list(doc.actions, "actions")
      .map((a) => object(a, "action"))
      .filter((a) => a.kind === "source-send" || a.kind === "source-retry")
      .map((a) => text(a.id, "id")),
  );
  const ids = new Set<string>();
  const targets = new Set<string>();
  return list(doc.faults === undefined ? [] : doc.faults, "faults", 100).map(
    (entry, i) => {
      const path = `faults[${i}]`;
      const rule = object(entry, path, ["id", "kind", "action", "probability"]);
      choice(rule.kind, `${path}.kind`, ["receipt-loss"]);
      const id = text(rule.id, `${path}.id`);
      unique(id, ids, `${path}.id`);
      const action = reference(rule.action, sourceActions, `${path}.action`);
      unique(action, targets, `${path}.action`);
      const probability = object(rule.probability, `${path}.probability`, [
        "numerator",
        "denominator",
      ]);
      const denominator = integer(
        probability.denominator,
        `${path}.denominator`,
        1000000,
        1,
      );
      const numerator = integer(
        probability.numerator,
        `${path}.numerator`,
        denominator,
      );
      return { id, action, numerator, denominator };
    },
  );
}

export type FaultKey = {
  seed: string;
  scenario: string;
  rule: string;
  actor: string;
  action: string;
  generation: number;
  attempt: number;
};
export function receiptDraw(
  key: FaultKey,
  numerator: number,
  denominator: number,
  drawIndex: number,
) {
  if (
    !/^[a-f0-9]{64}$/.test(key.seed) ||
    !Number.isSafeInteger(numerator) ||
    !Number.isSafeInteger(denominator) ||
    denominator < 1 ||
    denominator > 1000000 ||
    numerator < 0 ||
    numerator > denominator ||
    !Number.isInteger(drawIndex) ||
    drawIndex < 0 ||
    drawIndex >= 16
  )
    invalid("receipt draw", "invalid probability, seed or draw index");
  const hash = createHash("sha256");
  for (const part of [
    "zooglass-timeline-receipt-loss-v1",
    key.seed,
    key.scenario,
    key.rule,
    key.actor,
    key.action,
    String(key.generation),
    "source-receipt",
    String(key.attempt),
    "loss",
    String(drawIndex),
  ]) {
    const bytes = Buffer.from(part);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    hash.update(length).update(bytes);
  }
  const digest = hash.digest("hex");
  const sample = parseInt(digest.slice(0, 8), 16);
  const rejected = sample >= Math.floor(4294967296 / denominator) * denominator;
  return {
    algorithm: faultAlgorithm,
    drawIndex,
    digest,
    sample,
    rejected,
    lost: !rejected && sample % denominator < numerator,
    numerator,
    denominator,
  };
}
