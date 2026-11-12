import type { ViewSnapshot } from "../../vehicle-tracker/src/subscription-client.js";
export type { ViewSnapshot };
export const orderIds = Array.from(
  { length: 6 },
  (_, index) => `order-${index + 1}`,
);
export const views = ["order-summary", "order-tracking"] as const;
export type OrderView = (typeof views)[number];
export interface Fact {
  cycle: number;
  status: string;
  observedAt: number;
  reference?: string;
  items?: string[];
}

/** Presentation state only. ZooGlass owns field selection, readiness and freshness. */
export class OrderModel {
  readonly snapshots = new Map<string, ViewSnapshot>();
  readonly awaiting = new Set<string>();
  connected = false;
  connection = "Connecting…";
  selected = orderIds[0];
  view: OrderView = "order-summary";
  constructor() {
    this.beginConnection();
  }
  beginConnection() {
    this.connected = false;
    this.awaiting.clear();
    for (const view of views)
      for (const entity of orderIds) this.awaiting.add(`${view}/${entity}`);
  }
  accept(snapshot: ViewSnapshot) {
    if (
      !views.includes(snapshot.viewId as OrderView) ||
      !orderIds.includes(snapshot.entityId)
    )
      throw new Error("Unexpected Order snapshot identity.");
    if (
      !snapshot.data ||
      !snapshot.status?.fields ||
      !snapshot.status.inputs ||
      !snapshot.provenance ||
      !snapshot.publicationSequences ||
      !Number.isSafeInteger(snapshot.version)
    )
      throw new Error("Incomplete Order snapshot.");
    const key = `${snapshot.viewId}/${snapshot.entityId}`;
    // Never compare versions across connections or suppress metadata-only updates.
    this.snapshots.set(key, snapshot);
    this.awaiting.delete(key);
  }
  get(view: OrderView, id: string) {
    return this.snapshots.get(`${view}/${id}`);
  }
  saved(view: OrderView, id: string) {
    return !this.connected || this.awaiting.has(`${view}/${id}`);
  }
}
export function fact(
  snapshot: ViewSnapshot | undefined,
  field: string,
): Fact | undefined {
  const value = snapshot?.data[field];
  if (
    !value ||
    typeof value !== "object" ||
    !("status" in value) ||
    !("cycle" in value)
  )
    return;
  return value as Fact;
}
export function words(value: string) {
  return value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (letter) => letter.toUpperCase());
}
export function escape(value: unknown) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!,
  );
}
