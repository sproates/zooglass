import type { ViewSnapshot } from "../../vehicle-tracker/src/subscription-client.js";
export type { ViewSnapshot };
export const matchIds = ["match-1", "match-2", "match-3"];
export const views = ["match-market", "scoreboard", "first-reported"] as const;
export type SportsView = (typeof views)[number];
export type Layout = "board" | "scoreboard" | "comparison";
export const pairings = [
  ["Harbour Athletic", "Hilltown"],
  ["Riverside", "Northbridge"],
  ["Westfield", "Kingsford"],
];
export interface Match {
  home: string;
  away: string;
  cycle: number;
  period: string;
  simulatedClock: string;
  scoreWindowStart: number;
}
export interface Market {
  cycle: number;
  status: string;
  odds: { home: number; draw: number; away: number };
  basedOnMatchSequence: number;
}
export interface Goal {
  birthSequence: number;
  revision: number;
  payload: {
    kind: "goal";
    cycle: number;
    scorer: string;
    minute: number;
    points: number;
  };
}

/** Nine complete snapshots, never a goal ledger or a score reducer. */
export class SportsModel {
  readonly snapshots = new Map<string, ViewSnapshot>();
  readonly awaiting = new Set<string>();
  connected = false;
  connection = "Connecting · awaiting fresh snapshots";
  selected = matchIds[0];
  layout: Layout = "board";
  constructor() {
    this.beginConnection();
  }
  beginConnection() {
    this.connected = false;
    this.awaiting.clear();
    for (const view of views)
      for (const id of matchIds) this.awaiting.add(`${view}/${id}`);
  }
  accept(snapshot: ViewSnapshot) {
    if (
      !views.includes(snapshot.viewId as SportsView) ||
      !matchIds.includes(snapshot.entityId)
    )
      throw new Error("Unexpected Sports snapshot identity.");
    if (
      !snapshot.data ||
      !snapshot.status?.fields ||
      !snapshot.status.inputs ||
      !snapshot.provenance ||
      !snapshot.publicationSequences ||
      !Number.isSafeInteger(snapshot.version)
    )
      throw new Error("Incomplete Sports snapshot.");
    const key = `${snapshot.viewId}/${snapshot.entityId}`;
    // A fresh baseline may be empty or have a lower version. Status-only changes matter too.
    this.snapshots.set(key, snapshot);
    this.awaiting.delete(key);
  }
  get(view: SportsView, id = this.selected) {
    return this.snapshots.get(`${view}/${id}`);
  }
  saved(view: SportsView, id = this.selected) {
    return !this.connected || this.awaiting.has(`${view}/${id}`);
  }
}
export function match(snapshot?: ViewSnapshot): Match | undefined {
  const value = snapshot?.data.match as Match | undefined;
  if (
    value &&
    typeof value.home === "string" &&
    typeof value.away === "string" &&
    Number.isSafeInteger(value.cycle) &&
    Number.isSafeInteger(value.scoreWindowStart)
  )
    return value;
}
export function market(snapshot?: ViewSnapshot): Market | undefined {
  const value = snapshot?.data.market as Market | undefined;
  if (
    value &&
    typeof value.status === "string" &&
    Number.isSafeInteger(value.cycle) &&
    Number.isSafeInteger(value.basedOnMatchSequence) &&
    value.odds &&
    [value.odds.home, value.odds.draw, value.odds.away].every(Number.isFinite)
  )
    return value;
}
export function score(snapshot?: ViewSnapshot) {
  const metadata = match(snapshot);
  const home = snapshot?.status.fields.homeScore?.facts;
  const away = snapshot?.status.fields.awayScore?.facts;
  let phase = "Awaiting match";
  if (metadata) {
    phase =
      !home || !away
        ? "Awaiting score"
        : home.minimumBirthSequence !== metadata.scoreWindowStart ||
            away.minimumBirthSequence !== metadata.scoreWindowStart
          ? "Cycle transition"
          : home.activeCount < 1 || away.activeCount < 1
            ? "Awaiting score"
            : "Current score";
  }
  const homeTotal = snapshot?.data.homeScore;
  const awayTotal = snapshot?.data.awayScore;
  if (
    phase === "Current score" &&
    (typeof homeTotal !== "number" ||
      !Number.isFinite(homeTotal) ||
      typeof awayTotal !== "number" ||
      !Number.isFinite(awayTotal))
  )
    phase = "Awaiting score";
  const current = phase === "Current score";
  return {
    phase,
    home: current ? String(homeTotal) : "—",
    away: current ? String(awayTotal) : "—",
    current,
  };
}
/** Baselines are retained runtime facts, but are not scorer entries. */
export function goals(
  snapshot: ViewSnapshot | undefined,
  side: "home" | "away",
): Goal[] {
  const value = snapshot?.data[`${side}Goals`];
  return Array.isArray(value)
    ? value.filter(
        (goal): goal is Goal =>
          goal?.payload?.kind === "goal" &&
          typeof goal.payload.scorer === "string" &&
          Number.isFinite(goal.payload.minute),
      )
    : [];
}
export function marketBasis(snapshot?: ViewSnapshot): string {
  const metadata = match(snapshot);
  const report = market(snapshot);
  if (!report) return "Awaiting bookmaker report";
  if (!metadata) return "Awaiting match context";
  if (report.cycle !== metadata.cycle)
    return report.cycle < metadata.cycle
      ? "Previous-cycle market · not current"
      : "Market cycle ahead of match · not current";
  if (!score(snapshot).current)
    return "Score window transitioning · market not current";
  const observed = snapshot?.status.inputs["match-feed"]?.observedThrough;
  if (observed === null || observed === undefined)
    return "Feed progress not yet known";
  if (report.basedOnMatchSequence < observed)
    return "Market references an earlier feed boundary";
  if (report.basedOnMatchSequence > observed)
    return "Feed basis beyond known progress";
  return "Market references the observed feed boundary";
}
export function gaps(
  snapshot: ViewSnapshot | undefined,
  source: string,
): string {
  return (
    snapshot?.status.inputs[source]?.missingRanges
      .map(
        (range) =>
          `${range.status === "provisional" ? "Delayed or missing" : range.status === "confirmed" ? "Confirmed missing" : "Expired missing"} report ${range.from === range.through ? range.from : `${range.from}–${range.through}`}`,
      )
      .join("; ") ?? ""
  );
}
export function sameWindow(left?: ViewSnapshot, right?: ViewSnapshot) {
  const a = match(left),
    b = match(right);
  return (
    !!a &&
    !!b &&
    a.cycle === b.cycle &&
    a.scoreWindowStart === b.scoreWindowStart &&
    [left, right].every((snapshot) =>
      ["homeScore", "awayScore"].every(
        (field) =>
          snapshot?.status.fields[field]?.facts?.minimumBirthSequence ===
          a.scoreWindowStart,
      ),
    )
  );
}
export function escape(value: unknown) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!,
  );
}
