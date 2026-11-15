/** Serialization of explicit expected values. No fact reduction, summation or policy selection. */
import { epoch, type Body } from "./inputs.js";
export type Progress = {
  observed: number | null;
  watermark: number | null;
  complete: number | null;
  completeness: string;
  floor: number | null;
  violated: boolean;
  missing: { from: number; through: number; status: string }[];
};
export type FactEntry = {
  birthSequence: number;
  revision: number;
  payload: Record<string, unknown>;
};
export type Side = {
  present: boolean;
  floor: number;
  retained: number;
  active: number;
  score: number;
  entries: FactEntry[];
};
export type State = {
  entityId: string;
  version: number;
  match: Body | null;
  market: Body | null;
  marketAt: number | null;
  marketFreshness: string;
  home: Side;
  away: Side;
  matchProgress: Progress;
  bookProgress: Progress;
};
export const absentProgress: Progress = {
  observed: null,
  watermark: null,
  complete: null,
  completeness: "unknown",
  floor: null,
  violated: false,
  missing: [],
};
export const absentSide: Side = {
  present: false,
  floor: 1,
  retained: 0,
  active: 0,
  score: 0,
  entries: [],
};
export function snapshot(viewId: string, row: State) {
  const market = viewId === "match-market",
    collections = viewId !== "scoreboard";
  const fields = [
    "awayScore",
    "homeScore",
    "match",
    ...(collections ? ["awayGoals", "homeGoals"] : []),
    ...(market ? ["market"] : []),
  ].sort();
  const data: Record<string, unknown> = {},
    provenance: Record<string, unknown> = {};
  for (const name of fields) {
    if (name === "match" || name === "market") {
      const body = row[name];
      if (!body) continue;
      data[name] = {
        publicationSequence: body.publicationSequence,
        payload: body.payload,
      };
      provenance[name] = {
        sourceId: body.sourceId,
        epoch: "run",
        sourceEntityId: row.entityId,
      };
    } else {
      const side = name.startsWith("home") ? row.home : row.away;
      if (!side.present) continue;
      data[name] = name.endsWith("Score") ? side.score : side.entries;
      provenance[name] = {
        sourceId: "match-feed",
        epoch: "run",
        sourceEntityId: row.entityId,
      };
    }
  }
  const input = (p: Progress) => ({
    state: p.observed === null ? "notObserved" : "observed",
    mode: "contiguousSequence",
    epoch: "run",
    sourceEntityId: row.entityId,
    startSequence: 1,
    observedThrough: p.observed,
    watermarkThrough: p.watermark,
    completeThrough: p.complete,
    completeness: p.completeness,
    admissionFloor: p.floor,
    sourceContractViolated: p.violated,
    missingRanges: p.missing,
  });
  const missingFields = fields.filter((field) => !(field in data));
  return {
    viewId,
    entityId: row.entityId,
    version: row.version,
    data,
    provenance,
    status: {
      publication: missingFields.length ? "partial" : "ready",
      missingFields,
      missingRequiredFields: [],
      fields: Object.fromEntries(
        fields.map((field) => {
          const ordinary = field === "match" || field === "market",
            side = field.startsWith("home") ? row.home : row.away;
          return [
            field,
            {
              freshness: !(field in data)
                ? "absent"
                : field === "market"
                  ? row.marketFreshness
                  : "unspecified",
              receivedAtMillis:
                field === "market" && row.marketAt !== null
                  ? epoch + row.marketAt
                  : null,
              inputs: [field === "market" ? "bookmaker" : "match-feed"],
              ...(!ordinary
                ? {
                    facts: {
                      minimumBirthSequence: side.floor,
                      retainedCount: side.retained,
                      activeCount: side.active,
                    },
                  }
                : {}),
            },
          ];
        }),
      ),
      inputs: {
        "match-feed": input(row.matchProgress),
        ...(market ? { bookmaker: input(row.bookProgress) } : {}),
      },
    },
  };
}
export function frame(viewId: string, row: State) {
  const installed = snapshot(viewId, row),
    data = { ...installed.data },
    publicationSequences: Record<string, number[]> = {};
  for (const name of ["match", "market"]) {
    const body = row[name as "match" | "market"];
    if (body && name in data) {
      data[name] = body.payload;
      publicationSequences[name] = [body.publicationSequence];
    }
  }
  return { ...installed, type: "view-update", data, publicationSequences };
}
