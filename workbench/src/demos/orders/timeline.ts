import {
  orderEvent,
  orderIds,
  type OrderEvent,
  type OrderSource,
} from "./contracts.js";

export const ticksPerCycle = 36;
export type OrderAction =
  | { kind: "publish"; event: OrderEvent; unmapped?: true }
  | { kind: "omit"; event: OrderEvent }
  | { kind: "disconnect"; source: OrderSource }
  | { kind: "reconnect"; source: OrderSource }
  | {
      kind: "watermark";
      source: OrderSource;
      entityId: string;
      throughSequence: number;
    };
export interface OrderStep {
  tick: number;
  description: string;
  actions: OrderAction[];
}

/** Fixed-size schedule: one permanent loss, repeated delays and actual source outages. */
export function orderStep(
  tick: number,
  epoch: number,
  tickMs: number,
): OrderStep {
  if (
    !Number.isSafeInteger(tick) ||
    tick < 0 ||
    tick > Number.MAX_SAFE_INTEGER / 10
  ) {
    throw new Error(
      "Order simulation tick is outside the safe sequence range.",
    );
  }
  const cycle = Math.floor(tick / ticksPerCycle);
  const phase = tick % ticksPerCycle;
  const actions: OrderAction[] = [];
  const notices: string[] = [];
  const at = (phase: number, c = cycle) =>
    epoch + (c * ticksPerCycle + phase) * tickMs;
  const publish = (event: OrderEvent) =>
    actions.push({ kind: "publish", event });
  for (let i = 0; i < orderIds.length; i++) {
    const offset = i * 3;
    const local = phase - offset;
    const event = (
      source: OrderSource,
      revision: number,
      status: string,
      observed = phase,
    ) => orderEvent(source, i, cycle, revision, status, at(observed));
    const orderStatus = i === 2 ? "cancelled" : "dispatched";
    const paymentStatus = i === 2 ? "declined" : "authorised";
    const deliveryStatus = i === 2 ? "cancelled" : "inTransit";
    if (local === 0) publish(event("orders", 1, "accepted"));
    if (local === 1) publish(event("payments", 1, paymentStatus));
    if (local === 2) publish(event("courier-backup", 20, deliveryStatus));
    if (local === 3) publish(event("courier-primary", 1, deliveryStatus));
    if (local === 4) publish(event("orders", 3, orderStatus));
    if (local === 5)
      publish(
        event("inventory", 1, i === 2 ? "unavailable" : "reserved", offset + 2),
      );
    if (local === 6) {
      publish(event("orders", 2, "packing", offset + 3));
      notices.push(`${orderIds[i]}: delayed order report`);
    }
    if (local === 7) publish(event("orders", 3, orderStatus, offset + 4));
    if (local === 8) {
      const payment = event("payments", 2, paymentStatus);
      actions.push({
        kind: cycle === 0 && i === 1 ? "omit" : "publish",
        event: payment,
      });
      publish(event("courier-backup", 21, deliveryStatus));
    }
    if (local === 9) publish(event("payments", 3, paymentStatus));
    if (phase === 26)
      publish(event("payments", 4, i === 5 ? "refunded" : paymentStatus));
    if (phase === 29) publish(event("courier-backup", 22, deliveryStatus));
    if (phase === 32)
      publish(
        event(
          "inventory",
          2,
          i === 5 ? "released" : i === 2 ? "unavailable" : "reserved",
        ),
      );
    if (phase === 33)
      publish(
        event(
          "courier-primary",
          2,
          i === 2 || i === 5 ? "cancelled" : "delivered",
        ),
      );
    if (phase === 34) {
      for (const [source, revision] of [
        ["orders", i === 5 ? 4 : 3],
        ["payments", 4],
        ["inventory", 2],
      ] as const) {
        const last = event(source, revision, "unused");
        actions.push({
          kind: "watermark",
          source,
          entityId: last.entityId,
          throughSequence: last.publicationSequence,
        });
      }
    }
  }
  if (phase === 24) actions.push({ kind: "disconnect", source: "inventory" });
  if (phase === 25)
    publish(orderEvent("orders", 5, cycle, 4, "cancelled", at(phase)));
  if (phase === 31) actions.push({ kind: "reconnect", source: "inventory" });
  if (phase === 35 && cycle === 0) {
    const event = orderEvent("payments", 0, 0, 1, "authorised", at(phase));
    actions.push({
      kind: "publish",
      event: { ...event, entityId: "payment-unmapped" },
      unmapped: true,
    });
  }
  if (phase === 1 && cycle > 0) {
    publish(
      orderEvent("orders", 0, cycle - 1, 3, "dispatched", at(4, cycle - 1)),
    );
  }
  return {
    tick,
    description: notices.join("; ") || "Independent configured contributions",
    actions,
  };
}

export function orderTimeline(epoch = Date.now(), tickMs = 3000): OrderStep[] {
  return Array.from({ length: ticksPerCycle }, (_, tick) =>
    orderStep(tick, epoch, tickMs),
  );
}
