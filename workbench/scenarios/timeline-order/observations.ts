/** Wire serialization of explicit state rows. No strategy selection or transition evaluation. */
import { entity, epoch, inputs, sourceIds, type Source } from "./inputs.js";
export const summary = "order-summary",
  tracking = "order-tracking";
const publications = new Map(inputs().sends.map((send) => [send.id, send]));
export type Progress = {
  observed: number | null;
  watermark: number | null;
  complete: number | null;
  completeness: string;
  gaps: { from: number; through: number; status: string }[];
};
const P = (
  observed: number | null,
  watermark: number | null = null,
  complete: number | null = null,
  completeness = "unknown",
  gaps: Progress["gaps"] = [],
): Progress => ({ observed, watermark, complete, completeness, gaps });
const gap = (sequence: number, status = "provisional") => [
  { from: sequence, through: sequence, status },
];
// Named literal progress observations. No interval arithmetic or inferred gap closure.
export const progress = {
  absent: P(null),
  one: P(1),
  two: P(2),
  threeGap: P(3, null, null, "unknown", gap(2)),
  three: P(3),
  four: P(4),
  paymentGap3: P(3, null, null, "unknown", gap(2)),
  paymentGap4: P(4, null, null, "unknown", gap(2)),
  ordersW3: P(3, 3, 3, "completeThrough"),
  ordersW4: P(4, 4, 4, "completeThrough"),
  paymentsW4: P(4, 4, 4, "completeThrough"),
  paymentMissingW4: P(4, 4, null, "incomplete", gap(2, "confirmed")),
  inventoryW2: P(2, 2, 2, "completeThrough"),
  orders4: P(4, 3, 3, "completeThrough"),
  orders5: P(5, 4, 4, "completeThrough"),
  orders6Gap: P(6, 3, 3, "completeThrough", gap(5)),
  orders7Gap: P(7, 4, 4, "completeThrough", gap(6)),
  orders6: P(6, 3, 3, "completeThrough"),
  orders7: P(7, 4, 4, "completeThrough"),
  orders8: P(8, 4, 4, "completeThrough"),
  payments5: P(5, 4, 4, "completeThrough"),
  payments6: P(6, 4, 4, "completeThrough"),
  payments7: P(7, 4, 4, "completeThrough"),
  payments8: P(8, 4, 4, "completeThrough"),
  missing5: P(5, 4, null, "incomplete", gap(2, "confirmed")),
  missing6: P(6, 4, null, "incomplete", gap(2, "confirmed")),
  missing7: P(7, 4, null, "incomplete", gap(2, "confirmed")),
  missing8: P(8, 4, null, "incomplete", gap(2, "confirmed")),
  inventory3: P(3, 2, 2, "completeThrough"),
  inventory4: P(4, 2, 2, "completeThrough"),
  ordersW6: P(6, 6, 6, "completeThrough"),
  ordersW8: P(8, 8, 8, "completeThrough"),
  paymentsW8: P(8, 8, 8, "completeThrough"),
  paymentMissingW8: P(8, 8, null, "incomplete", gap(2, "confirmed")),
  inventoryW4: P(4, 4, 4, "completeThrough"),
};
export type ProgressName = keyof typeof progress;
/** refs columns: order,payment,inventory,selected delivery. progress: orders,payments,inventory.
 * courier columns explicitly record which source streams have been observed.
 * versions are [summary,tracking]; stale explicitly names selected expired fields.
 */
export type StateRow = {
  index: number;
  versions: [number, number];
  refs: [string | null, string | null, string | null, string | null];
  progress: [ProgressName, ProgressName, ProgressName];
  couriers: [boolean, boolean];
  stale: string[];
  gate: boolean;
};
export function state(
  index: number,
  versions: [number, number],
  refs: StateRow["refs"],
  statuses: StateRow["progress"],
  couriers: StateRow["couriers"],
  stale: string[] = [],
  gate = true,
): StateRow {
  return { index, versions, refs, progress: statuses, couriers, stale, gate };
}
export function snapshot(row: StateRow, viewId: string) {
  const isTracking = viewId === tracking;
  const fields = [
    "delivery",
    "inventory",
    "order",
    ...(!isTracking ? ["payment"] : []),
  ];
  const refs = Object.fromEntries(
    ["order", "payment", "inventory", "delivery"].map((field, index) => [
      field,
      row.refs[index],
    ]),
  );
  const data: Record<string, unknown> = {},
    provenance: Record<string, unknown> = {};
  for (const field of fields) {
    const ref = refs[field];
    if (!ref || (isTracking && !row.gate)) continue;
    const { body } = publications.get(ref)!;
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
  const sourceProgress: Record<string, Progress> = {
    orders: progress[row.progress[0]],
    payments: progress[row.progress[1]],
    inventory: progress[row.progress[2]],
  };
  const inputs = Object.fromEntries(
    sourceIds
      .filter((source) => !isTracking || source !== "payments")
      .map((source) => {
        const tracked = source in sourceProgress,
          p = sourceProgress[source];
        const observed = tracked
          ? p.observed !== null
          : row.couriers[source === "courier-primary" ? 0 : 1];
        return [
          source,
          {
            state: observed ? "observed" : "notObserved",
            mode: tracked ? "contiguousSequence" : "untracked",
            epoch: "run",
            sourceEntityId: entity(source, row.index),
            startSequence: tracked ? 1 : null,
            observedThrough: tracked ? p.observed : null,
            watermarkThrough: tracked ? p.watermark : null,
            completeThrough: tracked ? p.complete : null,
            completeness: tracked ? p.completeness : "unknown",
            admissionFloor: observed ? 1 : null,
            sourceContractViolated: false,
            missingRanges: tracked ? p.gaps : [],
          },
        ];
      }),
  );
  const missingFields = fields.filter((field) => !refs[field]);
  const missingRequiredFields = isTracking
    ? ["inventory", "order"].filter((field) => !refs[field])
    : [];
  const status = {
    publication: missingRequiredFields.length
      ? "waiting"
      : missingFields.length
        ? "partial"
        : "ready",
    missingFields,
    missingRequiredFields,
    fields: Object.fromEntries(
      fields.map((field) => {
        const ref = refs[field],
          timed = field === "inventory" || field === "delivery";
        return [
          field,
          {
            freshness: !ref
              ? "absent"
              : !timed
                ? "unspecified"
                : row.stale.includes(field)
                  ? "stale"
                  : "fresh",
            receivedAtMillis:
              ref && timed ? epoch + publications.get(ref)!.atMs : null,
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
  };
  return {
    viewId,
    entityId: `order-${row.index + 1}`,
    version: row.versions[isTracking ? 1 : 0],
    data,
    provenance,
    status,
  };
}
export function frame(row: StateRow, viewId: string) {
  const installed = snapshot(row, viewId);
  const data = installed.data as Record<
    string,
    { publicationSequence: number; payload: unknown }
  >;
  return {
    ...installed,
    type: "view-update",
    data: Object.fromEntries(
      Object.entries(data).map(([field, value]) => [field, value.payload]),
    ),
    publicationSequences: Object.fromEntries(
      Object.entries(data).map(([field, value]) => [
        field,
        [value.publicationSequence],
      ]),
    ),
  };
}
export function sourceIdentity(source: Source, index: number) {
  return {
    sourceId: source,
    epoch: "run",
    sourceEntityId: entity(source, index),
  };
}
