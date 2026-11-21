import type { TraceEvent } from "../timeline/trace-generations.js";

export type DecisionAssociation = {
  event: TraceEvent;
  receipt: TraceEvent;
  attempt: TraceEvent;
  original?: string;
};

/** Follow recorded execution edges; shared timestamps never establish context. */
export function explanationContext(
  events: readonly TraceEvent[],
  decisions: readonly DecisionAssociation[],
  selected?: string,
): Set<string> {
  const byId = new Map(events.map((event) => [event.id, event]));
  if (selected === undefined) return new Set(byId.keys());
  if (!byId.has(selected)) throw new Error(`Unknown event ID: ${selected}`);
  const seeds = new Set([selected]);
  const parents = new Map<string, string[]>();
  const children = new Map<string, string[]>();
  for (const event of events) {
    const edges = [
      ...(event.parent === null ? [] : [event.parent]),
      ...event.causes,
    ];
    parents.set(event.id, edges);
    for (const parent of edges) {
      const ids = children.get(parent) ?? [];
      ids.push(event.id);
      children.set(parent, ids);
    }
  }
  // Ancestors provide provenance; their other descendants are unrelated siblings.
  const walk = (edges: Map<string, string[]>) => {
    const found = new Set(seeds);
    for (const id of found)
      for (const next of edges.get(id) ?? []) found.add(next);
    return found;
  };
  const ancestors = walk(parents);
  for (const { event, receipt, attempt } of decisions)
    if ([event.id, receipt.id, attempt.id].some((id) => ancestors.has(id))) {
      seeds.add(event.id);
      seeds.add(receipt.id);
      seeds.add(attempt.id);
    }
  const included = new Set([...walk(parents), ...walk(children)]);
  const associations = new Map<string, DecisionAssociation>();
  for (const association of decisions)
    for (const event of [
      association.event,
      association.receipt,
      association.attempt,
    ])
      associations.set(event.id, association);
  for (const id of included) {
    for (const parent of parents.get(id) ?? []) included.add(parent);
    const association = associations.get(id);
    if (!association) continue;
    included.add(association.event.id);
    included.add(association.receipt.id);
    included.add(association.attempt.id);
    if (association.original) included.add(association.original);
  }
  return included;
}
