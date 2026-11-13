import type { Json } from "./json.js";
import {
  integer,
  invalid,
  list,
  object,
  reference,
  text,
  unique,
} from "./validation.js";

export type RetryPolicy = {
  action: string;
  actor: string;
  publication: string;
  maxAttempts: number;
  receiptTimeoutMs: number;
  retryIntervalMs: number;
};
/** A managed source owns one retained publication and its lifecycle for this bounded profile. */
export function retryPolicies(doc: { [key: string]: Json }): RetryPolicy[] {
  const actions = list(doc.actions, "actions").map((a) => object(a, "action"));
  const sends = new Set(
    actions
      .filter((a) => a.kind === "source-send")
      .map((a) => text(a.id, "id")),
  );
  const actors = new Set<string>();
  return list(doc.retries === undefined ? [] : doc.retries, "retries", 10).map(
    (entry, i) => {
      const path = `retries[${i}]`;
      const policy = object(entry, path, [
        "action",
        "maxAttempts",
        "receiptTimeoutMs",
        "retryIntervalMs",
      ]);
      const action = reference(policy.action, sends, `${path}.action`);
      const send = actions.find((a) => a.id === action)!;
      const actor = text(send.actor, "actor");
      unique(actor, actors, path);
      const owned = actions.filter((a) => a.actor === actor);
      if (
        owned.length !== 2 ||
        owned.filter((a) => a.kind === "connect").length !== 1
      )
        invalid(
          path,
          "managed source permits only one initial connect and its source-send",
        );
      return {
        action,
        actor,
        publication: text(send.publication, "publication"),
        maxAttempts: integer(policy.maxAttempts, `${path}.maxAttempts`, 10, 1),
        receiptTimeoutMs: integer(
          policy.receiptTimeoutMs,
          `${path}.receiptTimeoutMs`,
          3600000,
        ),
        retryIntervalMs: integer(
          policy.retryIntervalMs,
          `${path}.retryIntervalMs`,
          3600000,
        ),
      };
    },
  );
}
