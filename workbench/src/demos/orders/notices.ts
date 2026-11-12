import type { OrderStep } from "./timeline.js";

/** Simulator delivery descriptions, deliberately separate from runtime decisions. */
export function describeOrderStep(step: OrderStep): string {
  if (step.description !== "Independent configured contributions")
    return step.description;
  const action =
    step.actions.find((item) => item.kind !== "publish") ?? step.actions[0];
  if (!action)
    return "Sources are quiet; retained values and freshness remain visible.";
  if (action.kind === "disconnect")
    return "Stock source disconnected; other sources keep reporting.";
  if (action.kind === "reconnect")
    return "Stock source reconnected; a new report is still needed to refresh stock.";
  if (action.kind === "watermark")
    return "Sources sent watermarks for completed delivery schedules.";
  const sourceNames: Record<string, string> = {
    orders: "order",
    payments: "payment",
    inventory: "stock",
    "courier-primary": "primary courier",
    "courier-backup": "backup courier",
  };
  if (action.kind === "publish" && action.unmapped)
    return "Diagnostic payment sent with an unmapped key; no order row is created.";
  const order = action.event.entityId.split("-").at(-1);
  const verb =
    action.kind === "omit"
      ? "intentionally omitted"
      : action.retry
        ? "resent with its original identity"
        : "sent";
  return `Order ${order}: ${sourceNames[action.event.sourceId]} report ${verb}.`;
}
