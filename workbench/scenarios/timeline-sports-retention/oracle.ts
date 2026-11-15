/** Independent literal stages. Collections serialize declared births; no strategy is executed. */
import {
  absentProgress,
  absentSide,
  snapshot as serialize,
  type Progress,
  type Side,
  type State,
} from "../timeline-sports/wire.js";
import { publications, stream, views, controls, sends } from "./inputs.js";
const fields = (view: string) =>
  view === "scoreboard" ? ["homeScore"] : ["homeGoals", "homeScore"];
function target(
  viewId: string,
  reason: string | null = null,
  changed = true,
  names = fields(viewId),
) {
  return {
    viewId,
    entityId: "match-1",
    status: reason ? "rejected" : "accepted",
    reason,
    changedFields: changed ? names : [],
    fields: names.map((field) => ({
      field,
      status: reason ? "rejected" : "accepted",
      reason,
      changed,
    })),
  };
}
function receipt(
  sequence: number,
  version: number,
  targets: ReturnType<typeof target>[],
  status = "committed",
  reason = "sqlite",
  changedViews = views,
) {
  return {
    status,
    reason,
    stream,
    publicationSequence: sequence,
    version,
    changedViews,
    targets,
  };
}
export const receipts = [
  ...Array.from({ length: 16 }, (_, i) =>
    receipt(
      i + 1,
      i + 1,
      views.map((view) => target(view)),
    ),
  ),
  receipt(
    17,
    17,
    views.map((view) =>
      target(
        view,
        view === "first-reported" ? "factImmutable" : null,
        view !== "first-reported",
      ),
    ),
  ),
  receipt(
    18,
    17,
    [target("match-market", "factLimit", false, ["homeGoals"])],
    "rejected",
    "factLimit",
    [],
  ),
  receipt(
    18,
    21,
    views.map((view) => target(view)),
  ),
  receipt(
    1,
    1,
    views.map((view) => target(view)),
    "duplicate",
    "alreadyCommitted",
    [],
  ),
  receipt(
    19,
    22,
    views.map((view) => target(view, "factOutsideRetention", false)),
  ),
  receipt(
    129,
    23,
    views.map((view) => target(view, null, true, ["match"])),
  ),
  receipt(
    2,
    2,
    views.map((view) => target(view)),
    "duplicate",
    "alreadyCommitted",
    [],
  ),
  receipt(1, 23, [], "rejected", "outsideRetention", []),
  receipt(
    257,
    24,
    views.map((view) => target(view, null, true, ["match"])),
  ),
];
export const retirementReceipts = controls.map((entry, index) => {
  const rejected = index === 1,
    unchanged = index === 5;
  return {
    kind: "factRetirement",
    status: rejected ? "rejected" : unchanged ? "unchanged" : "committed",
    reason: rejected ? "unknownFactField" : null,
    control: { ...entry.control, fields: [...entry.control.fields].sort() },
    version: [18, 18, 19, 20, 26, 26][index],
    floors: rejected
      ? {}
      : Object.fromEntries(
          entry.control.fields.map((field) => [
            field,
            entry.control.minimumBirthSequence,
          ]),
        ),
    changedViews: rejected || unchanged ? [] : [entry.control.viewId],
  };
});
export const progressReceipt = {
  kind: "watermark",
  status: "committed",
  reason: "sqlite",
  stream,
  throughSequence: 256,
  version: 25,
  changedViews: views,
};
const progress = (
  observed: number,
  floor = 1,
  missing: Progress["missing"] = [],
  watermark: number | null = null,
): Progress => ({
  observed,
  floor,
  missing,
  watermark,
  complete: null,
  completeness: watermark === null ? "unknown" : "incomplete",
  violated: false,
});
const births = (first: number, last: number) =>
  Array.from({ length: last - first + 1 }, (_, i) => first + i);
const side = (
  ids: number[],
  retained: number,
  floor: number,
  score: number,
): Side => ({
  present: true,
  floor,
  retained,
  active: ids.length,
  score,
  entries: ids.map((birthSequence) => ({
    birthSequence,
    revision: 1,
    payload: { points: 1 },
  })),
});
const all = side(births(1, 16), 16, 1, 16),
  tombstone = side(births(2, 16), 16, 1, 15),
  retired = side(births(2, 16), 15, 2, 15),
  replenished = side([...births(2, 16), 18], 16, 2, 16),
  last = side([...births(3, 16), 18], 15, 3, 15);
const provisional = [{ from: 20, through: 128, status: "provisional" }];
const expired = [
  { from: 20, through: 128, status: "expired" },
  { from: 130, through: 256, status: "provisional" },
];
const confirmed = [
  { from: 20, through: 128, status: "expired" },
  { from: 130, through: 256, status: "confirmed" },
];
type Checkpoint = {
  id: string;
  atMs: number;
  versions: number[];
  home: Side[];
  progress: Progress;
  match: State["match"];
};
export const checkpoints: Checkpoint[] = [
  {
    id: "capacity",
    atMs: 161,
    versions: [16, 16, 16],
    home: [all, all, all],
    progress: progress(16),
    match: null,
  },
  {
    id: "tombstone",
    atMs: 171,
    versions: [17, 17, 17],
    home: [tombstone, tombstone, all],
    progress: progress(17),
    match: null,
  },
  {
    id: "full-rejected",
    atMs: 181,
    versions: [17, 17, 17],
    home: [tombstone, tombstone, all],
    progress: progress(17),
    match: null,
  },
  {
    id: "one-view-retired",
    atMs: 204,
    versions: [18, 17, 17],
    home: [retired, tombstone, all],
    progress: progress(17),
    match: null,
  },
  {
    id: "partial-failure",
    atMs: 214,
    versions: [18, 17, 17],
    home: [retired, tombstone, all],
    progress: progress(17),
    match: null,
  },
  {
    id: "all-retired",
    atMs: 234,
    versions: [18, 19, 20],
    home: [retired, retired, retired],
    progress: progress(17),
    match: null,
  },
  {
    id: "capacity-freed",
    atMs: 241,
    versions: [21, 21, 21],
    home: [replenished, replenished, replenished],
    progress: progress(18),
    match: null,
  },
  {
    id: "outside-fact-committed",
    atMs: 261,
    versions: [22, 22, 22],
    home: [replenished, replenished, replenished],
    progress: progress(19),
    match: null,
  },
  {
    id: "identity-boundary",
    atMs: 271,
    versions: [23, 23, 23],
    home: [replenished, replenished, replenished],
    progress: progress(129, 2, provisional),
    match: publications.edge,
  },
  {
    id: "identity-retries",
    atMs: 291,
    versions: [23, 23, 23],
    home: [replenished, replenished, replenished],
    progress: progress(129, 2, provisional),
    match: publications.edge,
  },
  {
    id: "expired-gap",
    atMs: 301,
    versions: [24, 24, 24],
    home: [replenished, replenished, replenished],
    progress: progress(257, 130, expired),
    match: publications.expired,
  },
  {
    id: "confirmed-gap",
    atMs: 311,
    versions: [25, 25, 25],
    home: [replenished, replenished, replenished],
    progress: progress(257, 130, confirmed, 256),
    match: publications.expired,
  },
  {
    id: "lost-reply-committed",
    atMs: 1003,
    versions: [26, 25, 25],
    home: [last, replenished, replenished],
    progress: progress(257, 130, confirmed, 256),
    match: publications.expired,
  },
  {
    id: "equal-floor",
    atMs: 1010,
    versions: [26, 25, 25],
    home: [last, replenished, replenished],
    progress: progress(257, 130, confirmed, 256),
    match: publications.expired,
  },
];
export function snapshot(checkpoint: Checkpoint, index: number) {
  return serialize(views[index], {
    entityId: "match-1",
    version: checkpoint.versions[index],
    match: checkpoint.match,
    market: null,
    marketAt: null,
    marketFreshness: "absent",
    home: checkpoint.home[index],
    away: absentSide,
    matchProgress: checkpoint.progress,
    bookProgress: absentProgress,
  });
}
export function sourceReceipts(atMs: number) {
  return receipts.filter((_, index) => sends[index].atMs <= atMs);
}
export function controlReceipts(atMs: number) {
  return retirementReceipts.filter(
    (_, index) => index !== 4 && controls[index].atMs + 4 <= atMs,
  );
}
