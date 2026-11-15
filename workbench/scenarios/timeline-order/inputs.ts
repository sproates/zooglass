/** Fixed two-cycle adaptation of the completed Order demo at ad04db982cf32e4f26919a7ffbbb042e48212a78.
 * Input generation only: no runtime imports, state reduction or outcome calculation.
 * Within each tick, original producer receipt barriers become distinct 1ms slots.
 */
export const epoch = 1700000000000;
export const tickMillis = 3000;
export const sourceIds = [
  "orders",
  "payments",
  "inventory",
  "courier-primary",
  "courier-backup",
] as const;
export type Source = (typeof sourceIds)[number];
const prefixes = {
  orders: "order",
  payments: "payment",
  inventory: "reservation",
  "courier-primary": "shipment",
  "courier-backup": "tracking",
};
const types = {
  orders: "order.state",
  payments: "payment.state",
  inventory: "inventory.state",
  "courier-primary": "delivery.state",
  "courier-backup": "delivery.state",
};
const items = [
  "Arc desk lamp",
  "Studio headphones",
  "Pour-over set",
  "Everyday backpack",
  "Reading light",
  "Desk organiser",
];
export function entity(source: Source, index: number) {
  return `${prefixes[source]}-${index + 1}`;
}
export function publication(
  source: Source,
  index: number,
  cycle: number,
  revision: number,
  status: string,
  observedPhase: number,
) {
  const stride =
    source === "orders"
      ? index === 5
        ? 4
        : 3
      : source === "payments"
        ? 4
        : source === "courier-backup"
          ? 3
          : 2;
  return {
    sourceId: source,
    epoch: "run",
    sourceEntityId: entity(source, index),
    publicationSequence: cycle * stride + revision,
    type: types[source],
    payload: {
      cycle: cycle + 1,
      observedAt: epoch + (cycle * 36 + observedPhase) * tickMillis,
      status,
      ...(source === "orders"
        ? { reference: `DEMO-${cycle + 1}-${index + 1}`, items: [items[index]] }
        : {}),
    },
  };
}
export type Publication = ReturnType<typeof publication>;
export type Send = {
  kind: "publish";
  id: string;
  tick: number;
  atMs: number;
  index: number;
  body: Publication;
  retry: boolean;
  unmapped: boolean;
};
export type Control = {
  kind: "watermark";
  id: string;
  tick: number;
  atMs: number;
  index: number;
  control: {
    sourceId: Source;
    epoch: string;
    sourceEntityId: string;
    throughSequence: number;
  };
};
export type Connection = {
  kind: "disconnect" | "connect";
  id: string;
  tick: number;
  atMs: number;
  source: Source;
};
export type Omission = { tick: number; body: Publication };
export function inputs() {
  const sends: Send[] = [],
    controls: Control[] = [],
    connections: Connection[] = [],
    omissions: Omission[] = [];
  for (let tick = 0; tick < 72; tick++) {
    const cycle = Math.floor(tick / 36),
      phase = tick % 36;
    let ordinal = 0;
    const send = (
      index: number,
      body: Publication,
      retry = false,
      unmapped = false,
    ) => {
      const id = `p${tick}-${ordinal}`;
      sends.push({
        kind: "publish",
        id,
        tick,
        atMs: tick * tickMillis + 10 + ordinal++,
        index,
        body,
        retry,
        unmapped,
      });
    };
    for (let i = 0; i < 6; i++) {
      const offset = i * 3,
        local = phase - offset;
      const event = (
        source: Source,
        revision: number,
        status: string,
        observed = phase,
      ) => publication(source, i, cycle, revision, status, observed);
      const orderStatus = i === 2 ? "cancelled" : "dispatched",
        paymentStatus = i === 2 ? "declined" : "authorised",
        deliveryStatus = i === 2 ? "cancelled" : "inTransit";
      if (local === 0) send(i, event("orders", 1, "accepted"));
      if (local === 1) send(i, event("payments", 1, paymentStatus));
      if (local === 2) send(i, event("courier-backup", 20, deliveryStatus));
      if (local === 3) send(i, event("courier-primary", 1, deliveryStatus));
      if (local === 4) send(i, event("orders", 3, orderStatus));
      if (local === 5)
        send(
          i,
          event(
            "inventory",
            1,
            i === 2 ? "unavailable" : "reserved",
            offset + 2,
          ),
        );
      if (local === 6) send(i, event("orders", 2, "packing", offset + 3));
      if (local === 7)
        send(i, event("orders", 3, orderStatus, offset + 4), true);
      if (local === 8) {
        const payment = event("payments", 2, paymentStatus);
        if (cycle === 0 && i === 1) omissions.push({ tick, body: payment });
        else send(i, payment);
        send(i, event("courier-backup", 21, deliveryStatus));
      }
      if (local === 9) send(i, event("payments", 3, paymentStatus));
      if (phase === 26)
        send(i, event("payments", 4, i === 5 ? "refunded" : paymentStatus));
      if (phase === 29) send(i, event("courier-backup", 22, deliveryStatus));
      if (phase === 32)
        send(
          i,
          event(
            "inventory",
            2,
            i === 5 ? "released" : i === 2 ? "unavailable" : "reserved",
          ),
        );
      if (phase === 33)
        send(
          i,
          event(
            "courier-primary",
            2,
            i === 2 || i === 5 ? "cancelled" : "delivered",
          ),
        );
      if (phase === 34)
        for (const [source, revision] of [
          ["orders", i === 5 ? 4 : 3],
          ["payments", 4],
          ["inventory", 2],
        ] as const) {
          const last = event(source, revision, "unused"),
            id = `w${tick}-${ordinal}`;
          controls.push({
            kind: "watermark",
            id,
            tick,
            atMs: tick * tickMillis + 10 + ordinal++,
            index: i,
            control: {
              sourceId: source,
              epoch: "run",
              sourceEntityId: last.sourceEntityId,
              throughSequence: last.publicationSequence,
            },
          });
        }
    }
    if (phase === 24 || phase === 31)
      connections.push({
        kind: phase === 24 ? "disconnect" : "connect",
        id: `inventory-${tick}`,
        tick,
        atMs: tick * tickMillis,
        source: "inventory",
      });
    if (phase === 25)
      send(5, publication("orders", 5, cycle, 4, "cancelled", phase));
    if (phase === 35 && cycle === 0)
      send(
        0,
        {
          ...publication("payments", 0, 0, 1, "authorised", phase),
          sourceEntityId: "payment-unmapped",
        },
        false,
        true,
      );
    if (phase === 1 && cycle > 0)
      send(0, publication("orders", 0, cycle - 1, 3, "dispatched", 4), true);
  }
  return { sends, controls, connections, omissions };
}
