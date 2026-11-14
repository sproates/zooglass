/** Literal admission/outcome ledger. Numbers include independent freshness commits;
 * duplicate rows retain their original version and target disposition. */
import { inputs, type Send } from "./inputs.js";
import { summary, tracking } from "./observations.js";
type Shape =
  | "order-waiting"
  | "retry-order-waiting"
  | "order-published"
  | "retry-order-published"
  | "late-order-gap-closure"
  | "payment"
  | "delivery-waiting"
  | "delivery-published"
  | "backup-unselected"
  | "inventory-opens-gate"
  | "inventory-published"
  | "unmapped";
type Row = [number, Shape];
export const receiptRows: Record<number, Row[]> = {
  0: [[1, "order-waiting"]],
  1: [[2, "payment"]],
  2: [[3, "delivery-waiting"]],
  3: [
    [4, "delivery-waiting"],
    [5, "order-waiting"],
  ],
  4: [
    [6, "order-waiting"],
    [7, "payment"],
  ],
  5: [
    [8, "inventory-opens-gate"],
    [9, "delivery-waiting"],
  ],
  6: [
    [10, "late-order-gap-closure"],
    [11, "delivery-waiting"],
    [12, "order-waiting"],
  ],
  7: [
    [6, "retry-order-waiting"],
    [13, "order-waiting"],
    [14, "payment"],
  ],
  8: [
    [16, "payment"],
    [17, "backup-unselected"],
    [18, "inventory-opens-gate"],
    [19, "delivery-waiting"],
  ],
  9: [
    [20, "payment"],
    [21, "late-order-gap-closure"],
    [22, "delivery-waiting"],
    [23, "order-waiting"],
  ],
  10: [
    [13, "retry-order-waiting"],
    [25, "order-waiting"],
    [26, "payment"],
  ],
  11: [
    [27, "backup-unselected"],
    [29, "inventory-opens-gate"],
    [30, "delivery-waiting"],
  ],
  12: [
    [31, "payment"],
    [32, "late-order-gap-closure"],
    [33, "delivery-waiting"],
    [34, "order-waiting"],
  ],
  13: [
    [25, "retry-order-waiting"],
    [35, "order-waiting"],
    [37, "payment"],
  ],
  14: [
    [38, "payment"],
    [39, "backup-unselected"],
    [41, "inventory-opens-gate"],
    [42, "delivery-waiting"],
  ],
  15: [
    [43, "payment"],
    [44, "late-order-gap-closure"],
    [45, "delivery-waiting"],
    [46, "order-waiting"],
  ],
  16: [
    [35, "retry-order-waiting"],
    [48, "order-waiting"],
    [49, "payment"],
  ],
  17: [
    [50, "payment"],
    [51, "backup-unselected"],
    [53, "inventory-opens-gate"],
    [54, "delivery-waiting"],
  ],
  18: [
    [55, "payment"],
    [56, "late-order-gap-closure"],
    [57, "delivery-waiting"],
  ],
  19: [
    [48, "retry-order-waiting"],
    [58, "order-waiting"],
  ],
  20: [
    [60, "payment"],
    [61, "backup-unselected"],
    [63, "inventory-opens-gate"],
  ],
  21: [
    [64, "payment"],
    [65, "late-order-gap-closure"],
  ],
  22: [[58, "retry-order-waiting"]],
  23: [
    [67, "payment"],
    [68, "backup-unselected"],
  ],
  24: [[70, "payment"]],
  25: [[71, "order-published"]],
  26: [
    [73, "payment"],
    [74, "payment"],
    [75, "payment"],
    [76, "payment"],
    [77, "payment"],
    [78, "payment"],
  ],
  29: [
    [79, "backup-unselected"],
    [80, "backup-unselected"],
    [81, "backup-unselected"],
    [82, "backup-unselected"],
    [83, "backup-unselected"],
    [84, "backup-unselected"],
  ],
  32: [
    [85, "inventory-published"],
    [86, "inventory-published"],
    [87, "inventory-published"],
    [88, "inventory-published"],
    [89, "inventory-published"],
    [90, "inventory-published"],
  ],
  33: [
    [91, "delivery-published"],
    [92, "delivery-published"],
    [93, "delivery-published"],
    [94, "delivery-published"],
    [95, "delivery-published"],
    [96, "delivery-published"],
  ],
  35: [[115, "unmapped"]],
  36: [[116, "order-published"]],
  37: [
    [118, "payment"],
    [6, "retry-order-waiting"],
  ],
  38: [[125, "backup-unselected"]],
  39: [
    [131, "delivery-published"],
    [132, "order-published"],
  ],
  40: [
    [133, "order-published"],
    [134, "payment"],
  ],
  41: [
    [135, "inventory-published"],
    [136, "backup-unselected"],
  ],
  42: [
    [137, "late-order-gap-closure"],
    [138, "delivery-published"],
    [139, "order-published"],
  ],
  43: [
    [133, "retry-order-published"],
    [140, "order-published"],
    [141, "payment"],
  ],
  44: [
    [143, "payment"],
    [144, "backup-unselected"],
    [145, "inventory-published"],
    [146, "backup-unselected"],
  ],
  45: [
    [147, "payment"],
    [148, "late-order-gap-closure"],
    [149, "delivery-published"],
    [150, "order-published"],
  ],
  46: [
    [140, "retry-order-published"],
    [152, "order-published"],
    [153, "payment"],
  ],
  47: [
    [154, "payment"],
    [156, "backup-unselected"],
    [157, "inventory-published"],
    [158, "backup-unselected"],
  ],
  48: [
    [159, "payment"],
    [160, "late-order-gap-closure"],
    [161, "delivery-published"],
    [162, "order-published"],
  ],
  49: [
    [152, "retry-order-published"],
    [163, "order-published"],
    [165, "payment"],
  ],
  50: [
    [166, "payment"],
    [167, "backup-unselected"],
    [169, "inventory-published"],
    [170, "backup-unselected"],
  ],
  51: [
    [171, "payment"],
    [172, "late-order-gap-closure"],
    [173, "delivery-published"],
    [174, "order-published"],
  ],
  52: [
    [163, "retry-order-published"],
    [175, "order-published"],
    [177, "payment"],
  ],
  53: [
    [178, "payment"],
    [179, "backup-unselected"],
    [181, "inventory-published"],
    [182, "backup-unselected"],
  ],
  54: [
    [183, "payment"],
    [184, "late-order-gap-closure"],
    [185, "delivery-published"],
  ],
  55: [
    [175, "retry-order-published"],
    [186, "order-published"],
  ],
  56: [
    [188, "payment"],
    [189, "backup-unselected"],
    [191, "inventory-published"],
  ],
  57: [
    [192, "payment"],
    [193, "late-order-gap-closure"],
  ],
  58: [[186, "retry-order-published"]],
  59: [
    [195, "payment"],
    [196, "backup-unselected"],
  ],
  60: [[198, "payment"]],
  61: [[199, "order-published"]],
  62: [
    [201, "payment"],
    [202, "payment"],
    [203, "payment"],
    [204, "payment"],
    [205, "payment"],
    [206, "payment"],
  ],
  65: [
    [207, "backup-unselected"],
    [208, "backup-unselected"],
    [209, "backup-unselected"],
    [210, "backup-unselected"],
    [211, "backup-unselected"],
    [212, "backup-unselected"],
  ],
  68: [
    [213, "inventory-published"],
    [214, "inventory-published"],
    [215, "inventory-published"],
    [216, "inventory-published"],
    [217, "inventory-published"],
    [218, "inventory-published"],
  ],
  69: [
    [219, "delivery-published"],
    [220, "delivery-published"],
    [221, "delivery-published"],
    [222, "delivery-published"],
    [223, "delivery-published"],
    [224, "delivery-published"],
  ],
};
export const controlVersions: Record<number, number[]> = {
  34: [
    97, 98, 99, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112,
    113, 114,
  ],
  70: [
    225, 226, 227, 228, 229, 230, 231, 232, 233, 234, 235, 236, 237, 238, 239,
    240, 241, 242,
  ],
};
export const expiries: [number, number][] = [
  [24010, 15],
  [30010, 24],
  [33011, 28],
  [39012, 36],
  [42012, 40],
  [48011, 47],
  [51012, 52],
  [57012, 59],
  [60012, 62],
  [66012, 66],
  [69012, 69],
  [75012, 72],
  [111010, 117],
  [111011, 119],
  [111012, 120],
  [111013, 121],
  [111014, 122],
  [111015, 123],
  [114010, 124],
  [114011, 126],
  [114012, 127],
  [114013, 128],
  [114014, 129],
  [114015, 130],
  [132010, 142],
  [138010, 151],
  [141011, 155],
  [147012, 164],
  [150012, 168],
  [156012, 176],
  [159012, 180],
  [165012, 187],
  [168012, 190],
  [174012, 194],
  [177012, 197],
  [183012, 200],
];
// Each shape explicitly declares selected field, public changed fields and changed views.
const shapes: Record<
  Exclude<Shape, "unmapped">,
  { field: string; sum: string[]; track: string[] | null; views: string[] }
> = {
  "order-waiting": {
    field: "order",
    sum: ["order"],
    track: [],
    views: [summary, tracking],
  },
  "retry-order-waiting": {
    field: "order",
    sum: ["order"],
    track: [],
    views: [],
  },
  "order-published": {
    field: "order",
    sum: ["order"],
    track: ["order"],
    views: [summary, tracking],
  },
  "retry-order-published": {
    field: "order",
    sum: ["order"],
    track: ["order"],
    views: [],
  },
  "late-order-gap-closure": {
    field: "order",
    sum: [],
    track: [],
    views: [summary, tracking],
  },
  payment: {
    field: "payment",
    sum: ["payment"],
    track: null,
    views: [summary],
  },
  "delivery-waiting": {
    field: "delivery",
    sum: ["delivery"],
    track: [],
    views: [summary, tracking],
  },
  "delivery-published": {
    field: "delivery",
    sum: ["delivery"],
    track: ["delivery"],
    views: [summary, tracking],
  },
  "backup-unselected": { field: "delivery", sum: [], track: [], views: [] },
  "inventory-opens-gate": {
    field: "inventory",
    sum: ["inventory"],
    track: ["delivery", "inventory", "order"],
    views: [summary, tracking],
  },
  "inventory-published": {
    field: "inventory",
    sum: ["inventory"],
    track: ["inventory"],
    views: [summary, tracking],
  },
};
export function receipt(send: Send) {
  const ordinal = Number(send.id.split("-")[1]);
  const [version, code] = receiptRows[send.tick][ordinal];
  const shape = code === "unmapped" ? null : shapes[code];
  const duplicate =
    code === "retry-order-waiting" || code === "retry-order-published";
  const target = (viewId: string, changedFields: string[]) => ({
    viewId,
    entityId: `order-${send.index + 1}`,
    status: "accepted",
    reason: null,
    changedFields,
    fields: [
      {
        field: shape!.field,
        status: "accepted",
        reason: null,
        changed: changedFields.includes(shape!.field),
      },
    ],
  });
  return {
    status: duplicate ? "duplicate" : "committed",
    reason: duplicate ? "alreadyCommitted" : "sqlite",
    stream: {
      sourceId: send.body.sourceId,
      epoch: "run",
      sourceEntityId: send.body.sourceEntityId,
    },
    publicationSequence: send.body.publicationSequence,
    version,
    changedViews: shape?.views ?? [],
    targets: shape
      ? [
          target(summary, shape.sum),
          ...(shape.track ? [target(tracking, shape.track)] : []),
        ]
      : [
          {
            viewId: summary,
            entityId: null,
            status: "rejected",
            reason: "unknownEntityMapping",
            changedFields: [],
            fields: [],
          },
        ],
  };
}
export function controlReceipts() {
  return inputs().controls.map((input) => ({
    kind: "watermark",
    status: "committed",
    reason: "sqlite",
    stream: {
      sourceId: input.control.sourceId,
      epoch: "run",
      sourceEntityId: input.control.sourceEntityId,
    },
    throughSequence: input.control.throughSequence,
    version: controlVersions[input.tick][Number(input.id.split("-")[1])],
    changedViews:
      input.control.sourceId === "payments" ? [summary] : [summary, tracking],
  }));
}
