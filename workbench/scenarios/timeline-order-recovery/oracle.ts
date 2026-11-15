/** Literal installed states and receipt outcomes; helpers only serialize declared rows. */
import {
  beforeSends,
  controlA,
  controlB,
  epoch,
  publications,
  summary,
  tracking,
  variants,
  type PublicationId,
  type Variant,
} from "./inputs.js";
type Row = {
  index: number;
  version: number;
  order: PublicationId | null;
  inventory: PublicationId | null;
  delivery: PublicationId | null;
  orders: number | null;
  inventorySequence: number | null;
  watermark: number | null;
  primary: boolean;
  backup: boolean;
  inventoryFreshness: string;
  deliveryFreshness: string;
};
const row = (
  index: number,
  version: number,
  refs: [PublicationId | null, PublicationId | null, PublicationId | null],
  progress: [number | null, number | null, number | null],
  couriers: [boolean, boolean],
  freshness: [string, string] = ["fresh", "fresh"],
): Row => ({
  index,
  version,
  order: refs[0],
  inventory: refs[1],
  delivery: refs[2],
  orders: progress[0],
  inventorySequence: progress[1],
  watermark: progress[2],
  primary: couriers[0],
  backup: couriers[1],
  inventoryFreshness: freshness[0],
  deliveryFreshness: freshness[1],
});
export const rows = {
  empty1: row(1, 0, [null, null, null], [null, null, null], [false, false]),
  empty2: row(2, 0, [null, null, null], [null, null, null], [false, false]),
  order1: row(1, 1, ["order1", null, null], [1, null, null], [false, false]),
  order2: row(2, 2, ["order2", null, null], [1, null, null], [false, false]),
  backup1: row(
    1,
    3,
    ["order1", null, "backup1"],
    [1, null, null],
    [false, true],
  ),
  backup2: row(
    2,
    4,
    ["order2", null, "backup2"],
    [1, null, null],
    [false, true],
  ),
  inventory1: row(
    1,
    5,
    ["order1", "inventory1", "backup1"],
    [1, 1, null],
    [false, true],
  ),
  primary1: row(
    1,
    6,
    ["order1", "inventory1", "primary1"],
    [1, 1, null],
    [true, true],
  ),
  primary2: row(
    2,
    7,
    ["order2", null, "primary2"],
    [1, null, null],
    [true, true],
  ),
  committedA: row(
    1,
    8,
    ["order1", "inventory1", "primary1"],
    [1, 1, 1],
    [true, true],
  ),
  recoveredBefore1: row(
    1,
    8,
    ["order1", "inventory1", "primary1"],
    [1, 1, 1],
    [true, true],
  ),
  recoveredBefore2: row(
    2,
    7,
    ["order2", null, "primary2"],
    [1, null, null],
    [true, true],
  ),
  recoveredAt1: row(
    1,
    9,
    ["order1", "inventory1", "primary1"],
    [1, 1, 1],
    [true, true],
    ["stale", "fresh"],
  ),
  recoveredAt2: row(
    2,
    7,
    ["order2", null, "primary2"],
    [1, null, null],
    [true, true],
  ),
  recoveredAfter1: row(
    1,
    9,
    ["order1", "inventory1", "primary1"],
    [1, 1, 1],
    [true, true],
    ["stale", "stale"],
  ),
  recoveredAfter2: row(
    2,
    9,
    ["order2", null, "primary2"],
    [1, null, null],
    [true, true],
    ["absent", "stale"],
  ),
  boundaryNextOrder2: row(
    2,
    10,
    ["nextOrder2", null, "primary2"],
    [2, null, null],
    [true, true],
  ),
  committedB: row(
    2,
    10,
    ["order2", null, "primary2"],
    [1, null, 1],
    [true, true],
    ["absent", "stale"],
  ),
  gateOpened: row(
    2,
    11,
    ["order2", "inventory2", "primary2"],
    [1, 1, 1],
    [true, true],
    ["fresh", "stale"],
  ),
  readyGateRetained: row(
    1,
    12,
    ["nextOrder1", "inventory1", "primary1"],
    [2, 1, 1],
    [true, true],
    ["stale", "stale"],
  ),
  primaryRefreshed: row(
    1,
    14,
    ["nextOrder1", "inventory1", "freshPrimary1"],
    [2, 1, 1],
    [true, true],
    ["stale", "fresh"],
  ),
  inventoryRefreshed: row(
    1,
    15,
    ["nextOrder1", "freshInventory1", "freshPrimary1"],
    [2, 2, 1],
    [true, true],
  ),
};
export type RowName = keyof typeof rows;
export const recovered: Record<Variant, [RowName, RowName]> = {
  before: ["recoveredBefore1", "recoveredBefore2"],
  at: ["recoveredAt1", "recoveredAt2"],
  after: ["recoveredAfter1", "recoveredAfter2"],
};
function receivedAt(id: PublicationId, variant: Variant) {
  const fixed = new Map(beforeSends.map(([at, key]) => [key, at]));
  const after: Partial<Record<PublicationId, number>> = {
    inventory2: 14,
    nextOrder1: 16,
    freshBackup1: 17,
    freshPrimary1: 18,
    freshInventory1: 19,
    nextOrder2: 0,
  };
  return epoch + (fixed.get(id) ?? variants[variant].restart + after[id]!);
}
export function snapshot(name: RowName, viewId: string, variant: Variant) {
  const r = rows[name],
    isTracking = viewId === tracking;
  const refs: Record<string, PublicationId | null> = {
    order: r.order,
    inventory: r.inventory,
    delivery: r.delivery,
    ...(!isTracking ? { payment: null } : {}),
  };
  const fields = Object.keys(refs).sort(),
    readyGate = Boolean(r.order && r.inventory);
  const data: Record<string, unknown> = {},
    provenance: Record<string, unknown> = {};
  for (const field of fields) {
    const id = refs[field];
    if (!id || (isTracking && !readyGate)) continue;
    const body = publications[id];
    data[field] = {
      publicationSequence: body.publicationSequence,
      payload: body.payload,
    };
    provenance[field] = {
      sourceId: body.sourceId,
      epoch: "run",
      sourceEntityId: body.sourceEntityId,
    };
  }
  const input = (
    prefix: string,
    observed: number | null,
    watermark: number | null = null,
    tracked = true,
    known = false,
  ) => ({
    state: (tracked ? observed !== null : known) ? "observed" : "notObserved",
    mode: tracked ? "contiguousSequence" : "untracked",
    epoch: "run",
    sourceEntityId: `${prefix}-${r.index}`,
    startSequence: tracked ? 1 : null,
    observedThrough: observed,
    watermarkThrough: watermark,
    completeThrough: watermark,
    completeness: watermark === null ? "unknown" : "completeThrough",
    admissionFloor: (tracked ? observed !== null : known) ? 1 : null,
    sourceContractViolated: false,
    missingRanges: [],
  });
  const inputs = {
    orders: input("order", r.orders, r.watermark),
    inventory: input("reservation", r.inventorySequence),
    "courier-primary": input("shipment", null, null, false, r.primary),
    "courier-backup": input("tracking", null, null, false, r.backup),
    ...(!isTracking ? { payments: input("payment", null) } : {}),
  };
  const missingFields = fields.filter((field) => !refs[field]),
    missingRequiredFields = isTracking
      ? ["inventory", "order"].filter((field) => !refs[field])
      : [];
  return {
    viewId,
    entityId: `order-${r.index}`,
    version: r.version,
    data,
    provenance,
    status: {
      publication: missingRequiredFields.length
        ? "waiting"
        : missingFields.length
          ? "partial"
          : "ready",
      missingFields,
      missingRequiredFields,
      fields: Object.fromEntries(
        fields.map((field) => {
          const id = refs[field],
            timed = field === "inventory" || field === "delivery";
          return [
            field,
            {
              freshness: !id
                ? "absent"
                : field === "inventory"
                  ? r.inventoryFreshness
                  : field === "delivery"
                    ? r.deliveryFreshness
                    : "unspecified",
              receivedAtMillis: id && timed ? receivedAt(id, variant) : null,
              inputs:
                field === "delivery"
                  ? ["courier-backup", "courier-primary"]
                  : [
                      field === "order"
                        ? "orders"
                        : field === "payment"
                          ? "payments"
                          : "inventory",
                    ],
            },
          ];
        }),
      ),
      inputs,
    },
  };
}
export function frame(name: RowName, viewId: string, variant: Variant) {
  const state = snapshot(name, viewId, variant),
    data = state.data as Record<
      string,
      { publicationSequence: number; payload: unknown }
    >;
  return {
    ...state,
    type: "view-update",
    data: Object.fromEntries(
      Object.entries(data).map(([key, value]) => [key, value.payload]),
    ),
    publicationSequences: Object.fromEntries(
      Object.entries(data).map(([key, value]) => [
        key,
        [value.publicationSequence],
      ]),
    ),
  };
}
// Version, matching field, summary changed fields, tracking changed fields, changed views.
type ReceiptRow = [number, string, string[], string[], string[]];
const both = [summary, tracking];
export const receiptRows: Record<PublicationId, ReceiptRow> = {
  order1: [1, "order", ["order"], [], both],
  order2: [2, "order", ["order"], [], both],
  backup1: [3, "delivery", ["delivery"], [], both],
  backup2: [4, "delivery", ["delivery"], [], both],
  inventory1: [
    5,
    "inventory",
    ["inventory"],
    ["delivery", "inventory", "order"],
    both,
  ],
  primary1: [6, "delivery", ["delivery"], ["delivery"], both],
  primary2: [7, "delivery", ["delivery"], [], both],
  inventory2: [
    11,
    "inventory",
    ["inventory"],
    ["delivery", "inventory", "order"],
    both,
  ],
  nextOrder1: [12, "order", ["order"], ["order"], both],
  freshBackup1: [13, "delivery", [], [], []],
  freshPrimary1: [14, "delivery", ["delivery"], ["delivery"], both],
  freshInventory1: [15, "inventory", ["inventory"], ["inventory"], both],
  nextOrder2: [10, "order", ["order"], [], both],
};
export function receipt(id: PublicationId, duplicate = false) {
  const body = publications[id],
    [version, field, sum, track, changedViews] = receiptRows[id];
  const index = body.sourceEntityId.endsWith("-1") ? 1 : 2;
  return {
    status: duplicate ? "duplicate" : "committed",
    reason: duplicate ? "alreadyCommitted" : "sqlite",
    stream: {
      sourceId: body.sourceId,
      epoch: "run",
      sourceEntityId: body.sourceEntityId,
    },
    publicationSequence: body.publicationSequence,
    version,
    changedViews: duplicate ? [] : changedViews,
    targets: [
      [summary, sum],
      [tracking, track],
    ].map(([viewId, changedFields]) => ({
      viewId,
      entityId: `order-${index}`,
      status: "accepted",
      reason: null,
      changedFields,
      fields: [
        {
          field,
          status: "accepted",
          reason: null,
          changed: (changedFields as string[]).includes(field),
        },
      ],
    })),
  };
}
export function watermark(which: "A" | "B", duplicate = false) {
  const { throughSequence, ...stream } = which === "A" ? controlA : controlB;
  return {
    kind: "watermark",
    status: duplicate ? "duplicate" : "committed",
    reason: duplicate ? "alreadyCommitted" : "sqlite",
    stream,
    throughSequence,
    version: which === "A" ? 8 : 10,
    changedViews: duplicate ? [] : both,
  };
}
