import { staticRecoveryProfile } from "./evidence-versions.js";
import { actionPhase } from "./lifecycle.js";
import type { Json } from "./json.js";
import { integer, invalid, list, object } from "./validation.js";
import { staticActionKinds } from "./static-contract.js";

export const recoveryActionKinds = [
  ...staticActionKinds,
  "source-retry",
  "service-stop",
  "service-start",
];

/** A closed lifecycle extension; V3 keeps its original meaning. */
export function validateRecoveryDocument(doc: { [key: string]: Json }) {
  if (doc.faults !== undefined || doc.retries !== undefined)
    invalid("$", "static recovery does not admit faults or automatic retries");
  const runtime = object(doc.runtime, "$.runtime");
  if (runtime.profile !== staticRecoveryProfile)
    invalid("$.runtime.profile", "explicit static recovery profile required");
  for (const [index, value] of list(doc.links, "$.links").entries()) {
    const path = `$.links[${index}]`;
    integer(object(value, path).latencyMs, `${path}.latencyMs`, 0);
  }
  const actions = list(doc.actions, "$.actions")
    .map((value, index) => {
      const path = `$.actions[${index}]`;
      const action = object(value, path);
      if (!recoveryActionKinds.includes(String(action.kind)))
        invalid(`${path}.kind`, "unsupported static recovery action");
      return { action, path, index, at: integer(action.atMs, `${path}.atMs`) };
    })
    .sort(
      (a, b) =>
        a.at - b.at ||
        actionPhase(String(a.action.kind)) -
          actionPhase(String(b.action.kind)) ||
        a.index - b.index,
    );
  let running = true;
  for (const { action, path } of actions) {
    if (action.kind === "service-stop") running = false;
    else if (action.kind === "service-start") running = true;
    else if (!running)
      invalid(path, "static recovery actor actions require a running service");
  }
  for (const [index, value] of list(doc.assertions, "$.assertions").entries()) {
    const path = `$.assertions[${index}]`;
    const assertion = object(value, path);
    if (assertion.kind !== "runtime-data") continue;
    const at = integer(assertion.atMs, `${path}.atMs`);
    let available = true;
    for (const entry of actions) {
      if (entry.at > at) break;
      if (entry.action.kind === "service-stop") available = false;
      if (entry.action.kind === "service-start") available = true;
    }
    if (!available) invalid(path, "runtime-data requires an available runtime");
  }
}
