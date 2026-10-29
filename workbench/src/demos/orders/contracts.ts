import type { ScenarioView } from "../../scenario/scenario.js";

export const orderIds = Array.from({ length: 6 }, (_, i) => `order-${i + 1}`);
export const sourceIds = ["orders", "payments", "inventory"] as const;
export type OrderSource = (typeof sourceIds)[number];

export interface OrderFact {
  sequence: number;
  cycle: number;
  observedAt: number;
  status: string;
}

export interface OrderEvent {
  sourceId: OrderSource;
  type: string;
  entityId: string;
  payload: OrderFact & { reference?: string; items?: string[] };
}

const eventTypes: Record<OrderSource, string> = {
  orders: "order.state",
  payments: "payment.state",
  inventory: "inventory.state",
};

export function orderEvent(
  sourceId: OrderSource,
  index: number,
  cycle: number,
  revision: number,
  status: string,
  observedAt: number,
): OrderEvent {
  return {
    sourceId,
    type: eventTypes[sourceId],
    entityId: orderIds[index],
    payload: {
      sequence: cycle * 10 + revision,
      cycle: cycle + 1,
      observedAt,
      status,
      ...(sourceId === "orders"
        ? { reference: `DEMO-${cycle + 1}-${index + 1}`, items: ["Desk lamp"] }
        : {}),
    },
  };
}

const fields = {
  order: [{ sourceId: "orders", type: "order.state" }],
  payment: [{ sourceId: "payments", type: "payment.state" }],
  inventory: [{ sourceId: "inventory", type: "inventory.state" }],
};
const latest = { mode: "latestBySequence", sequenceField: "sequence" } as const;

export const orderViews: ScenarioView[] = [
  {
    id: "order-summary",
    fields,
    ordering: { order: latest, payment: latest, inventory: latest },
  },
  {
    id: "order-tracking",
    fields: { order: fields.order, inventory: fields.inventory },
    ordering: { order: latest, inventory: latest },
  },
];
