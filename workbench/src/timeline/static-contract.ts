import { type Json } from "./json.js";
import {
  integer,
  invalid,
  list,
  object,
  reference,
  text,
  unique,
} from "./validation.js";

export const staticActionKinds = [
  "connect",
  "disconnect",
  "source-send",
  "client-subscribe",
  "client-unsubscribe",
];
export const projectedAssertionKinds = ["runtime-data", "source-accepted"];

/** V3 is a deliberately closed family, not a new name for every V2 feature. */
export function validateStaticDocument(doc: { [key: string]: Json }) {
  if (doc.faults !== undefined || doc.retries !== undefined)
    invalid("$", "static views do not admit faults or retries");
  for (const [index, value] of list(doc.links, "$.links").entries()) {
    const path = `$.links[${index}]`;
    integer(object(value, path).latencyMs, `${path}.latencyMs`, 0);
  }
  const runtime = object(doc.runtime, "$.runtime");
  if (
    runtime.profile !== "memory-static-views-v1" ||
    runtime.storage !== "memory"
  )
    invalid(
      "$.runtime",
      "V3 requires explicit memory-static-views-v1 and memory storage",
    );
  if (doc.conversionReport !== undefined) {
    const name = text(doc.conversionReport, "$.conversionReport");
    if (
      name.startsWith("/") ||
      name.includes("\\") ||
      name.split("/").some((part) => !part || part === "." || part === "..") ||
      /^[A-Za-z]:/.test(name)
    )
      invalid("$.conversionReport", "expected relative contained file path");
  }
  const actions = list(doc.actions, "$.actions").map((value) =>
    object(value, "action"),
  );
  for (const [index, value] of list(doc.actors, "$.actors").entries()) {
    const actor = object(value, `$.actors[${index}]`);
    if (actor.role !== "source") continue;
    const connections = actions.filter(
      (action) =>
        action.actor === actor.id &&
        (action.kind === "connect" || action.kind === "disconnect"),
    );
    if (
      connections.length !== 1 ||
      connections[0].kind !== "connect" ||
      integer(connections[0].atMs, "source connect time") !== 0
    )
      invalid(
        `$.actors[${index}]`,
        "static sources require exactly one initial connect at time zero, without disconnect or reconnect",
      );
  }
  for (const [index, value] of list(doc.actions, "$.actions").entries()) {
    const action = object(value, `$.actions[${index}]`);
    if (!staticActionKinds.includes(String(action.kind)))
      invalid(`$.actions[${index}].kind`, "unsupported static-view action");
  }
}

export function validateProjectedAssertions(
  doc: { [key: string]: Json },
  recovery = false,
) {
  const actions = list(doc.actions, "$.actions").map((value) =>
    object(value, "action"),
  );
  const sends = new Map(
    actions
      .filter((action) => action.kind === "source-send")
      .map((action) => [text(action.id, "action.id"), action]),
  );
  const sources = new Set(
    list(doc.actors, "$.actors")
      .map((value) => object(value, "actor"))
      .filter((actor) => actor.role === "source")
      .map((actor) => text(actor.id, "actor.id")),
  );
  const targets = new Set(
    list(doc.observationTargets ?? [], "$.observationTargets").map((value) => {
      const target = object(value, "target");
      return JSON.stringify([target.viewId, target.entityId]);
    }),
  );
  const used = new Set<string>();
  for (const [index, value] of list(doc.assertions, "$.assertions").entries()) {
    const path = `$.assertions[${index}]`;
    const assertion = object(value, path);
    if (assertion.kind === "runtime-data") {
      object(assertion, path, [
        "id",
        "atMs",
        "kind",
        "viewId",
        "entityId",
        "expected",
      ]);
      text(assertion.viewId, `${path}.viewId`);
      text(assertion.entityId, `${path}.entityId`);
      object(assertion.expected, `${path}.expected`);
      if (!targets.has(JSON.stringify([assertion.viewId, assertion.entityId])))
        invalid(
          path,
          "runtime data assertion requires a declared observation target",
        );
    } else if (assertion.kind === "source-accepted") {
      object(assertion, path, ["id", "atMs", "kind", "actor", "send"]);
      reference(assertion.actor, sources, `${path}.actor`);
      const id = reference(
        assertion.send,
        new Set(sends.keys()),
        `${path}.send`,
      );
      unique(id, used, `${path}.send`);
      const send = sends.get(id)!;
      const at = integer(assertion.atMs, `${path}.atMs`);
      if (
        send.actor !== assertion.actor ||
        integer(send.atMs, "send.atMs") !== at ||
        (recovery
          ? actions.filter(
              (action) =>
                action.kind === "source-send" || action.kind === "source-retry",
            )
          : [...sends.values()]
        ).filter(
          (action) =>
            action.actor === assertion.actor &&
            integer(action.atMs, "action.atMs") === at,
        ).length !== 1
      )
        invalid(
          path,
          "source acceptance requires its actor's sole send at the same timestamp",
        );
    }
  }
}
