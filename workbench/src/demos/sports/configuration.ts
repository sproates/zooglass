import type {
  RuntimeConfiguration,
  RuntimeField,
  RuntimeView,
} from "../../service/runtime-contract.js";

export const matchIds = ["match-1", "match-2", "match-3"] as const;
export const sportsViews = [
  "match-market",
  "scoreboard",
  "first-reported",
] as const;
export type SportsView = (typeof sportsViews)[number];
export function factFields(view: SportsView): string[] {
  return view === "scoreboard"
    ? ["homeScore", "awayScore"]
    : ["homeGoals", "awayGoals", "homeScore", "awayScore"];
}
function latest(sourceId: string, type: string): RuntimeField {
  return {
    sourceId,
    type,
    mode: "latestBySequence",
    late: { mode: "acceptLate" },
  };
}
function view(id: SportsView): RuntimeView {
  const fields: Record<string, RuntimeField> = {
    match: latest("match-feed", "match.state"),
  };
  if (id === "match-market")
    fields.market = {
      ...latest("bookmaker", "market.state"),
      freshness: { mode: "receiptAge", staleAfterMillis: 15000 },
    };
  for (const name of factFields(id)) {
    const sum = name.endsWith("Score");
    fields[name] = {
      sourceId: "match-feed",
      type: name.startsWith("home") ? "home.contribution" : "away.contribution",
      mode: sum ? "sumActiveFacts" : "activeFacts",
      ...(sum ? { property: "points" } : {}),
      facts: {
        revision: id === "first-reported" ? "firstFact" : "latestFactRevision",
        maxRetainedFacts: 16,
        minimumBirthSequence: 1,
      },
      late: { mode: "acceptLate" },
    };
  }
  return {
    id,
    fields,
    publication: { mode: "publishPartial" },
    entities: {
      "match-feed": { mode: "envelopeEntity" },
      ...(id === "match-market"
        ? { bookmaker: { mode: "envelopeEntity" as const } }
        : {}),
    },
  };
}
export function sportsConfiguration(): RuntimeConfiguration {
  return {
    contractVersion: 2,
    storage: "sqlite",
    maxStreams: 16,
    identityWindow: 128,
    maxHistoryEntries: 64,
    sources: ["match-feed", "bookmaker"].map((id) => ({
      id,
      epoch: "run",
      progress: {
        mode: "contiguousSequence",
        startSequence: 1,
        maxReceivedRanges: 16,
        maxMissingRanges: 16,
      },
    })),
    views: sportsViews.map(view),
  };
}
