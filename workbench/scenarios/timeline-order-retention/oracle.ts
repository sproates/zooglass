/** Independent literal floor/progress/status rows. Serialization never calculates a window or gap. */
import {
  publications,
  stream,
  views,
  type Attempt,
  type PublicationId,
} from "./inputs.js";
type Missing = { from: number; through: number; status: string };
const missing = (from: number, through: number, status: string): Missing => ({
  from,
  through,
  status,
});
type Row = {
  version: number;
  selected: PublicationId | null;
  floor: number | null;
  observed: number | null;
  watermark: number | null;
  complete: number | null;
  completeness: string;
  violated: boolean;
  missing: Missing[];
};
const row = (
  version: number,
  selected: PublicationId | null,
  floor: number | null,
  observed: number | null,
  watermark: number | null,
  complete: number | null,
  completeness: string,
  violated: boolean,
  missing: Missing[],
): Row => ({
  version,
  selected,
  floor,
  observed,
  watermark,
  complete,
  completeness,
  violated,
  missing,
});
export const rows = {
  empty: row(0, null, null, null, null, null, "unknown", false, []),
  first: row(1, "first", 1, 1, null, null, "unknown", false, []),
  firstWatermark: row(2, "first", 1, 1, 1, 1, "completeThrough", false, []),
  edge: row(3, "edge", 1, 3, 1, 1, "completeThrough", false, [
    missing(2, 2, "provisional"),
  ]),
  lastInWindow: row(4, "lastInWindow", 1, 128, 1, 1, "completeThrough", false, [
    missing(2, 2, "provisional"),
    missing(4, 127, "provisional"),
  ]),
  crossedWindow: row(
    5,
    "crossedWindow",
    3,
    130,
    1,
    1,
    "completeThrough",
    false,
    [
      missing(2, 2, "expired"),
      missing(4, 127, "provisional"),
      missing(129, 129, "provisional"),
    ],
  ),
  confirmed: row(6, "crossedWindow", 3, 130, 128, null, "incomplete", false, [
    missing(2, 2, "expired"),
    missing(4, 127, "confirmed"),
    missing(129, 129, "provisional"),
  ]),
  provisionalClosed: row(
    7,
    "crossedWindow",
    3,
    130,
    128,
    null,
    "incomplete",
    false,
    [missing(2, 2, "expired"), missing(4, 127, "confirmed")],
  ),
  violated: row(8, "crossedWindow", 3, 130, 128, null, "violated", true, [
    missing(2, 2, "expired"),
    missing(5, 127, "confirmed"),
  ]),
};
export type RowName = keyof typeof rows;
export function snapshot(name: RowName, viewId: string) {
  const r = rows[name],
    tracking = viewId === "order-tracking",
    present = r.selected !== null;
  const fields = tracking
    ? ["delivery", "inventory", "order"]
    : ["delivery", "inventory", "order", "payment"];
  const body = r.selected ? publications[r.selected] : null;
  const absent = (prefix: string, tracked: boolean) => ({
    state: "notObserved",
    mode: tracked ? "contiguousSequence" : "untracked",
    epoch: "run",
    sourceEntityId: `${prefix}-1`,
    startSequence: tracked ? 1 : null,
    observedThrough: null,
    watermarkThrough: null,
    completeThrough: null,
    completeness: "unknown",
    admissionFloor: null,
    sourceContractViolated: false,
    missingRanges: [],
  });
  return {
    viewId,
    entityId: "order-1",
    version: r.version,
    data:
      present && !tracking
        ? {
            order: {
              publicationSequence: body!.publicationSequence,
              payload: body!.payload,
            },
          }
        : {},
    provenance: present && !tracking ? { order: stream } : {},
    status: {
      publication: tracking ? "waiting" : "partial",
      missingFields: fields.filter((field) => field !== "order" || !present),
      missingRequiredFields: tracking
        ? present
          ? ["inventory"]
          : ["inventory", "order"]
        : [],
      fields: Object.fromEntries(
        fields.map((field) => [
          field,
          {
            freshness: field === "order" && present ? "unspecified" : "absent",
            receivedAtMillis: null,
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
        ]),
      ),
      inputs: {
        orders: {
          state: present ? "observed" : "notObserved",
          mode: "contiguousSequence",
          epoch: "run",
          sourceEntityId: "order-1",
          startSequence: 1,
          observedThrough: r.observed,
          watermarkThrough: r.watermark,
          completeThrough: r.complete,
          completeness: r.completeness,
          admissionFloor: r.floor,
          sourceContractViolated: r.violated,
          missingRanges: r.missing,
        },
        inventory: absent("reservation", true),
        "courier-primary": absent("shipment", false),
        "courier-backup": absent("tracking", false),
        ...(!tracking ? { payments: absent("payment", true) } : {}),
      },
    },
  };
}
export function frame(name: RowName, viewId: string) {
  const value = snapshot(name, viewId),
    body = rows[name].selected ? publications[rows[name].selected!] : null;
  const published = body && viewId === "order-summary";
  return {
    ...value,
    type: "view-update",
    data: published ? { order: body.payload } : {},
    publicationSequences: published
      ? { order: [body.publicationSequence] }
      : {},
  };
}
export function receipt(attempt: Attempt) {
  const rejected =
    attempt.outcome === "outsideRetention" ||
    attempt.outcome === "identityConflict";
  return {
    status: rejected ? "rejected" : attempt.outcome,
    reason: rejected
      ? attempt.outcome
      : attempt.outcome === "duplicate"
        ? "alreadyCommitted"
        : "sqlite",
    stream,
    publicationSequence: publications[attempt.publication].publicationSequence,
    version: attempt.version,
    changedViews: attempt.viewsChanged ? views : [],
    targets: rejected
      ? []
      : views.map((viewId) => {
          const changed = viewId === "order-summary" && attempt.changed;
          return {
            viewId,
            entityId: "order-1",
            status: "accepted",
            reason: null,
            changedFields: changed ? ["order"] : [],
            fields: [
              { field: "order", status: "accepted", reason: null, changed },
            ],
          };
        }),
  };
}
