/** Sparse sequence-span boundary case, not 128 stored receipts or a 50-cycle run. */
export const epoch = 1700000000000;
export const source = "order-source",
  progress = "order-progress",
  viewer = "order-viewer";
export const views = ["order-summary", "order-tracking"];
export const stream = {
  sourceId: "orders",
  epoch: "run",
  sourceEntityId: "order-1",
};
const publication = (publicationSequence: number, status: string) => ({
  ...stream,
  publicationSequence,
  type: "order.state",
  payload: { status },
});
export const publications = {
  first: publication(1, "accepted"),
  edge: publication(3, "packing"),
  lastInWindow: publication(128, "dispatched"),
  crossedWindow: publication(130, "delivered"),
  changedEvicted: publication(1, "cancelled"),
  changedEdge: publication(3, "cancelled"),
  expiredGap: publication(2, "picking"),
  lateGap: publication(129, "inTransit"),
  confirmedLate: publication(4, "packed"),
};
export type PublicationId = keyof typeof publications;
export type Attempt = {
  atMs: number;
  publication: PublicationId;
  retry: boolean;
  outcome: "committed" | "duplicate" | "outsideRetention" | "identityConflict";
  version: number;
  changed: boolean;
  viewsChanged: boolean;
};
/** Explicit receipt outcomes; field changed and visible metadata change are distinct. */
export const attempts: Attempt[] = [
  {
    atMs: 10,
    publication: "first",
    retry: false,
    outcome: "committed",
    version: 1,
    changed: true,
    viewsChanged: true,
  },
  {
    atMs: 20,
    publication: "edge",
    retry: false,
    outcome: "committed",
    version: 3,
    changed: true,
    viewsChanged: true,
  },
  {
    atMs: 30,
    publication: "lastInWindow",
    retry: false,
    outcome: "committed",
    version: 4,
    changed: true,
    viewsChanged: true,
  },
  {
    atMs: 31,
    publication: "first",
    retry: true,
    outcome: "duplicate",
    version: 1,
    changed: true,
    viewsChanged: false,
  },
  {
    atMs: 40,
    publication: "crossedWindow",
    retry: false,
    outcome: "committed",
    version: 5,
    changed: true,
    viewsChanged: true,
  },
  {
    atMs: 41,
    publication: "first",
    retry: true,
    outcome: "outsideRetention",
    version: 5,
    changed: false,
    viewsChanged: false,
  },
  {
    atMs: 42,
    publication: "changedEvicted",
    retry: false,
    outcome: "outsideRetention",
    version: 5,
    changed: false,
    viewsChanged: false,
  },
  {
    atMs: 43,
    publication: "edge",
    retry: true,
    outcome: "duplicate",
    version: 3,
    changed: true,
    viewsChanged: false,
  },
  {
    atMs: 44,
    publication: "changedEdge",
    retry: false,
    outcome: "identityConflict",
    version: 5,
    changed: false,
    viewsChanged: false,
  },
  {
    atMs: 47,
    publication: "edge",
    retry: true,
    outcome: "duplicate",
    version: 3,
    changed: true,
    viewsChanged: false,
  },
  {
    atMs: 62,
    publication: "edge",
    retry: true,
    outcome: "duplicate",
    version: 3,
    changed: true,
    viewsChanged: false,
  },
  {
    atMs: 63,
    publication: "first",
    retry: true,
    outcome: "outsideRetention",
    version: 6,
    changed: false,
    viewsChanged: false,
  },
  {
    atMs: 64,
    publication: "expiredGap",
    retry: false,
    outcome: "outsideRetention",
    version: 6,
    changed: false,
    viewsChanged: false,
  },
  {
    atMs: 65,
    publication: "lateGap",
    retry: false,
    outcome: "committed",
    version: 7,
    changed: false,
    viewsChanged: true,
  },
  {
    atMs: 66,
    publication: "confirmedLate",
    retry: false,
    outcome: "committed",
    version: 8,
    changed: false,
    viewsChanged: true,
  },
];
export const controls = [
  {
    atMs: 11,
    throughSequence: 1,
    status: "committed",
    reason: "sqlite",
    version: 2,
    changedViews: views,
  },
  {
    atMs: 45,
    throughSequence: 1,
    status: "duplicate",
    reason: "alreadyCommitted",
    version: 2,
    changedViews: [],
  },
  {
    atMs: 46,
    throughSequence: 128,
    status: "committed",
    reason: "sqlite",
    version: 6,
    changedViews: views,
  },
  {
    atMs: 61,
    throughSequence: 128,
    status: "duplicate",
    reason: "alreadyCommitted",
    version: 6,
    changedViews: [],
  },
  {
    atMs: 67,
    throughSequence: 1,
    status: "rejected",
    reason: "backwardsWatermark",
    version: 8,
    changedViews: [],
  },
  {
    atMs: 68,
    throughSequence: 128,
    status: "duplicate",
    reason: "alreadyCommitted",
    version: 6,
    changedViews: [],
  },
];
