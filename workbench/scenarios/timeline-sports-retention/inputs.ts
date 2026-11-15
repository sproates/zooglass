/** Bounded fact capacity and sparse identity-window inputs; no result calculation. */
import type { Body } from "../timeline-sports/inputs.js";
export const views = ["match-market", "scoreboard", "first-reported"];
export const actors = {
  source: "retention-source",
  retirement: "retention-retirement",
  progress: "retention-progress",
};
export const stream = {
  sourceId: "match-feed",
  epoch: "run",
  sourceEntityId: "match-1",
};
const fact = (
  sequence: number,
  birth: number,
  revision: number,
  operation: string,
): Body => ({
  ...stream,
  publicationSequence: sequence,
  type: "home.contribution",
  fact: {
    birthSequence: birth,
    revision,
    operation: operation as "create" | "revise" | "retract",
  },
  payload: operation === "retract" ? {} : { points: 1 },
});
export const publications: Record<string, Body> = {
  ...Object.fromEntries(
    Array.from({ length: 16 }, (_, i) => [
      `birth-${i + 1}`,
      fact(i + 1, i + 1, 1, "create"),
    ]),
  ),
  retract: fact(17, 1, 2, "retract"),
  newFact: fact(18, 18, 1, "create"),
  retiredRevision: fact(19, 1, 3, "revise"),
  edge: {
    ...stream,
    publicationSequence: 129,
    type: "match.state",
    payload: { phase: "edge", observedAt: 1700000000270 },
  },
  expired: {
    ...stream,
    publicationSequence: 257,
    type: "match.state",
    payload: { phase: "expired", observedAt: 1700000000300 },
  },
};
export const sends = [
  ...Array.from({ length: 16 }, (_, i) => ({
    id: `create-${i + 1}`,
    atMs: (i + 1) * 10,
    publication: `birth-${i + 1}`,
  })),
  { id: "retract", atMs: 170, publication: "retract" },
  { id: "full", atMs: 180, publication: "newFact" },
  { id: "new-after-retirement", atMs: 240, publication: "newFact" },
  { id: "retained-duplicate", atMs: 250, publication: "birth-1" },
  { id: "retired-revision", atMs: 260, publication: "retiredRevision" },
  { id: "identity-edge", atMs: 270, publication: "edge" },
  { id: "inclusive-duplicate", atMs: 280, publication: "birth-2" },
  { id: "evicted", atMs: 290, publication: "birth-1" },
  { id: "gap-expiry", atMs: 300, publication: "expired" },
];
export const retirement = (
  viewId: string,
  floor: number,
  fields = viewId === "scoreboard" ? ["homeScore"] : ["homeScore", "homeGoals"],
) => ({ viewId, entityId: "match-1", fields, minimumBirthSequence: floor });
export const controls = [
  { id: "retire-market", atMs: 200, control: retirement("match-market", 2) },
  {
    id: "invalid-scoreboard",
    atMs: 210,
    control: retirement("scoreboard", 2, ["homeScore", "match"]),
  },
  { id: "retire-scoreboard", atMs: 220, control: retirement("scoreboard", 2) },
  { id: "retire-first", atMs: 230, control: retirement("first-reported", 2) },
  { id: "lost-ack", atMs: 1000, control: retirement("match-market", 3) },
  { id: "equal-floor", atMs: 1005, control: retirement("match-market", 3) },
];
export const watermark = { ...stream, throughSequence: 256 };
