/** Fixed recovery inputs use the exact accepted Order configuration and real lookup IDs. */
export const epoch = 1700000000000;
export const source = "all-order-sources",
  progress = "order-progress";
export const viewers = ["viewer-a", "viewer-b"];
export const summary = "order-summary",
  tracking = "order-tracking";
export const targets = [1, 2].flatMap((index) =>
  [summary, tracking].map((viewId) => ({ viewId, entityId: `order-${index}` })),
);
const publication = (
  sourceId: string,
  sourceEntityId: string,
  publicationSequence: number,
  type: string,
  status: string,
) => ({
  sourceId,
  epoch: "run",
  sourceEntityId,
  publicationSequence,
  type,
  payload: { status },
});
export const publications = {
  order1: publication("orders", "order-1", 1, "order.state", "accepted"),
  order2: publication("orders", "order-2", 1, "order.state", "accepted"),
  backup1: publication(
    "courier-backup",
    "tracking-1",
    20,
    "delivery.state",
    "inTransit",
  ),
  backup2: publication(
    "courier-backup",
    "tracking-2",
    20,
    "delivery.state",
    "inTransit",
  ),
  inventory1: publication(
    "inventory",
    "reservation-1",
    1,
    "inventory.state",
    "reserved",
  ),
  primary1: publication(
    "courier-primary",
    "shipment-1",
    1,
    "delivery.state",
    "inTransit",
  ),
  primary2: publication(
    "courier-primary",
    "shipment-2",
    1,
    "delivery.state",
    "inTransit",
  ),
  inventory2: publication(
    "inventory",
    "reservation-2",
    1,
    "inventory.state",
    "reserved",
  ),
  nextOrder1: publication("orders", "order-1", 2, "order.state", "dispatched"),
  freshBackup1: publication(
    "courier-backup",
    "tracking-1",
    21,
    "delivery.state",
    "delivered",
  ),
  freshPrimary1: publication(
    "courier-primary",
    "shipment-1",
    2,
    "delivery.state",
    "delivered",
  ),
  freshInventory1: publication(
    "inventory",
    "reservation-1",
    2,
    "inventory.state",
    "reserved",
  ),
  nextOrder2: publication("orders", "order-2", 2, "order.state", "dispatched"),
};
export type PublicationId = keyof typeof publications;
export const beforeSends: [number, PublicationId][] = [
  [1, "order1"],
  [2, "order2"],
  [10, "backup1"],
  [11, "backup2"],
  [20, "inventory1"],
  [21, "primary1"],
  [22, "primary2"],
];
export const controlA = {
  sourceId: "orders",
  epoch: "run",
  sourceEntityId: "order-1",
  throughSequence: 1,
};
export const controlB = {
  sourceId: "orders",
  epoch: "run",
  sourceEntityId: "order-2",
  throughSequence: 1,
};
export const variants = {
  before: {
    restart: 15019,
    until: 15019,
    mode: "orderly",
    recoveryVersions: [8, 7],
    inventoryFreshness: "fresh",
    deliveryFreshness: "fresh",
  },
  at: {
    restart: 15020,
    until: 15020,
    mode: "abrupt",
    recoveryVersions: [9, 7],
    inventoryFreshness: "stale",
    deliveryFreshness: "fresh",
  },
  after: {
    restart: 15023,
    until: 15047,
    mode: "abrupt",
    recoveryVersions: [9, 9],
    inventoryFreshness: "stale",
    deliveryFreshness: "stale",
  },
} as const;
export type Variant = keyof typeof variants;
