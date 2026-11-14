/** Narrow ordinary-service comparison, authored before observing any service run.
 * Full clock/version assertions stay in the controlled Order fixtures. */
import { inputs } from "../scenarios/timeline-order/inputs.js";
import { orderOne } from "../scenarios/timeline-order/order-one.js";
import {
  frame,
  state,
  type StateRow,
} from "../scenarios/timeline-order/observations.js";
import {
  receipt,
  controlReceipts,
} from "../scenarios/timeline-order/receipts.js";

export const exclusions = {
  version:
    "Real receipt-age expiry can allocate global versions at different transport barriers; exact retries still retain the original committed version.",
  "status.fields.*.receivedAtMillis":
    "Actual service receipt samples use the real clock; selected timestamps must remain unchanged on reconnect/non-selected input and advance on selected refresh.",
  type: "HTTP snapshots have no view-update envelope; the same business/status projection is checked on client frames.",
  frameOrderAndCount:
    "Independent socket dispatch and real expiry timing are not a virtual trace; named client state barriers must still be observed.",
};
export type PublicState = Omit<ReturnType<typeof frame>, "version" | "type"> & {
  version?: number;
  type?: string;
};
export function projectState(value: PublicState) {
  const copy = structuredClone(value);
  delete copy.version;
  delete copy.type;
  for (const field of Object.values(copy.status.fields))
    delete (field as { receivedAtMillis?: number | null }).receivedAtMillis;
  return copy;
}
export function projectReceipt(value: {
  version?: number;
  [key: string]: unknown;
}) {
  const copy = { ...value };
  delete copy.version;
  return copy;
}
export const initialSteps = [
  ["p0-0", "accepted"],
  ["p1-0", "payment"],
  ["p2-0", "backup"],
  ["p3-0", "primary"],
  ["p4-0", "dispatchGap"],
  ["p5-0", "gateOpen"],
  ["p6-0", "gapClosed"],
  ["p7-0", "gapClosed"],
] as const;
export const parityStates: Record<string, StateRow> = {
  ...orderOne,
  paymentGap: state(
    0,
    [0, 0],
    ["p4-0", "p9-0", "p5-0", "p3-0"],
    ["three", "paymentGap3", "one"],
    [true, true],
  ),
  paymentFour: state(
    0,
    [0, 0],
    ["p4-0", "p26-0", "p5-0", "p3-0"],
    ["three", "paymentGap4", "one"],
    [true, true],
  ),
  confirmedGap: state(
    0,
    [0, 0],
    ["p4-0", "p26-0", "p5-0", "p3-0"],
    ["three", "paymentMissingW4", "one"],
    [true, true],
  ),
  expired: state(
    0,
    [0, 0],
    ["p4-0", "p26-0", "p5-0", "p3-0"],
    ["three", "paymentMissingW4", "one"],
    [true, true],
    ["delivery", "inventory"],
  ),
  refreshedInventory: state(
    0,
    [0, 0],
    ["p4-0", "p26-0", "p32-0", "p3-0"],
    ["three", "paymentMissingW4", "two"],
    [true, true],
    ["delivery"],
  ),
  refreshedPrimary: state(
    0,
    [0, 0],
    ["p4-0", "p26-0", "p32-0", "p33-0"],
    ["three", "paymentMissingW4", "two"],
    [true, true],
  ),
};
const all = inputs();
export const sends = Object.fromEntries(
  all.sends.map((send) => [send.id, send]),
);
export function expectedReceipt(id: string) {
  return projectReceipt(receipt(sends[id]));
}
export function expectedState(name: string, view: string) {
  return projectState(frame(parityStates[name], view));
}
export const watermark = all.controls.find(
  (control) => control.id === "w34-1",
)!;
export const watermarkReceipt = projectReceipt(
  controlReceipts()[all.controls.indexOf(watermark)],
);
export const selectedSends = [
  ...initialSteps.map(([id]) => id),
  "p9-0",
  "p26-0",
  "p35-0",
  "p29-0",
  "p32-0",
  "p33-0",
];
