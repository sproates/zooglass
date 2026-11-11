export const orderIds = Array.from({ length: 6 }, (_, i) => `order-${i + 1}`);
export const sourceIds = [
  "orders",
  "payments",
  "inventory",
  "courier-primary",
  "courier-backup",
] as const;
export type OrderSource = (typeof sourceIds)[number];

export interface OrderFact {
  cycle: number;
  observedAt: number;
  status: string;
}

export interface OrderEvent {
  sourceId: OrderSource;
  type: string;
  entityId: string;
  publicationSequence: number;
  payload: OrderFact & { reference?: string; items?: string[] };
}

const prefixes: Record<OrderSource, string> = {
  orders: "order",
  payments: "payment",
  inventory: "reservation",
  "courier-primary": "shipment",
  "courier-backup": "tracking",
};
const eventTypes: Record<OrderSource, string> = {
  orders: "order.state",
  payments: "payment.state",
  inventory: "inventory.state",
  "courier-primary": "delivery.state",
  "courier-backup": "delivery.state",
};

export function sourceEntity(source: OrderSource, index: number) {
  return `${prefixes[source]}-${index + 1}`;
}

/** Allocate contiguous sequences on tracked streams; retries reuse the original revision. */
export function orderEvent(
  sourceId: OrderSource,
  index: number,
  cycle: number,
  revision: number,
  status: string,
  observedAt: number,
): OrderEvent {
  const revisionsPerCycle: Record<OrderSource, number> = {
    orders: index === 5 ? 4 : 3,
    payments: 4,
    inventory: 2,
    "courier-primary": 2,
    "courier-backup": 3,
  };
  const stride = revisionsPerCycle[sourceId];
  const publicationSequence = cycle * stride + revision;
  if (!Number.isSafeInteger(publicationSequence) || publicationSequence < 1) {
    throw new Error("Order publication sequence exceeds its safe range.");
  }
  return {
    sourceId,
    type: eventTypes[sourceId],
    entityId: sourceEntity(sourceId, index),
    publicationSequence,
    payload: {
      cycle: cycle + 1,
      observedAt,
      status,
      ...(sourceId === "orders"
        ? { reference: `DEMO-${cycle + 1}-${index + 1}`, items: ["Desk lamp"] }
        : {}),
    },
  };
}
