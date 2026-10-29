import {
  orderEvent,
  orderIds,
  type OrderEvent,
  type OrderSource,
} from "./contracts.js";

export const ticksPerCycle = 36;
export type OrderAction =
  | { kind: "publish"; event: OrderEvent }
  | { kind: "omit"; event: OrderEvent }
  | { kind: "disconnect"; source: OrderSource }
  | { kind: "reconnect"; source: OrderSource };

export interface OrderStep {
  tick: number;
  description: string;
  actions: OrderAction[];
}

/** Fixed-sized delivery schedule. Delayed reports retain their original observation time. */
export function orderStep(
  tick: number,
  epoch: number,
  tickMs: number,
): OrderStep {
  if (
    !Number.isSafeInteger(tick) ||
    tick < 0 ||
    tick > Number.MAX_SAFE_INTEGER / 10
  )
    throw new Error(
      "Order simulation tick is outside the safe sequence range.",
    );

  const cycle = Math.floor(tick / ticksPerCycle);
  const phase = tick % ticksPerCycle;
  const actions: OrderAction[] = [];
  const notices: string[] = [];
  const at = (local: number, eventCycle = cycle) =>
    epoch + (eventCycle * ticksPerCycle + local) * tickMs;
  const publish = (event: OrderEvent) =>
    actions.push({ kind: "publish", event });

  for (let i = 0; i < orderIds.length; i++) {
    const offset = i * 3;
    const local = phase - offset;
    const event = (
      source: OrderSource,
      revision: number,
      status: string,
      observedPhase = phase,
    ) => orderEvent(source, i, cycle, revision, status, at(observedPhase));

    if (local === 0) publish(event("orders", 1, "accepted"));
    if (local === 1)
      publish(event("payments", 1, i === 2 ? "declined" : "authorised"));
    if (local === 4)
      publish(event("orders", 3, i === 2 ? "cancelled" : "dispatched"));
    if (local === 5) {
      publish(
        event("inventory", 1, i === 2 ? "unavailable" : "reserved", offset + 2),
      );
      notices.push(`${orderIds[i]}: late inventory contribution`);
    }
    if (local === 6) {
      publish(event("orders", 2, "packing", offset + 3));
      notices.push(
        `${orderIds[i]}: older order report delivered after newer state`,
      );
    }
    if (local === 7) {
      publish(
        event("orders", 3, i === 2 ? "cancelled" : "dispatched", offset + 4),
      );
      notices.push(`${orderIds[i]}: duplicate order report`);
    }
    if (local === 8) {
      actions.push({
        kind: "omit",
        event: event("payments", 2, i === 2 ? "declined" : "authorised"),
      });
      notices.push(`${orderIds[i]}: payment revision 2 permanently omitted`);
    }
    if (local === 9)
      publish(event("payments", 3, i === 2 ? "declined" : "authorised"));
  }

  if (phase === 24) {
    actions.push({ kind: "disconnect", source: "inventory" });
    notices.push("inventory source disconnected");
  }
  if (phase === 25)
    publish(orderEvent("orders", 5, cycle, 4, "cancelled", at(phase)));
  if (phase === 26)
    publish(orderEvent("payments", 5, cycle, 4, "refunded", at(phase)));
  if (phase === 27) {
    for (let i = 0; i < orderIds.length; i++)
      actions.push({
        kind: "omit",
        event: orderEvent(
          "inventory",
          i,
          cycle,
          2,
          i === 5 ? "released" : i === 2 ? "unavailable" : "reserved",
          at(phase),
        ),
      });
  }
  if (phase === 28) {
    actions.push({ kind: "reconnect", source: "inventory" });
    for (let i = 0; i < orderIds.length; i++)
      publish(
        orderEvent(
          "inventory",
          i,
          cycle,
          3,
          i === 5 ? "released" : i === 2 ? "unavailable" : "reserved",
          at(27),
        ),
      );
    notices.push(
      "inventory source reconnected with latest full state; revision 2 was not delivered",
    );
  }
  if (phase === 1 && cycle > 0) {
    publish(
      orderEvent("orders", 0, cycle - 1, 3, "dispatched", at(4, cycle - 1)),
    );
    notices.push(
      "order-1: previous-cycle report delivered after new-cycle acceptance",
    );
  }

  return {
    tick,
    description: notices.join("; ") || "Independent order contributions",
    actions,
  };
}

/** Finite timeline for the later interactive binding; no timers or sockets are owned here. */
export function orderTimeline(epoch = Date.now(), tickMs = 1000): OrderStep[] {
  return Array.from({ length: ticksPerCycle }, (_, tick) =>
    orderStep(tick, epoch, tickMs),
  );
}
