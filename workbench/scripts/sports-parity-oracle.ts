/** Independently authored scoped Sports observations. Tables serialize expectations;
 * they neither run reconciliation nor consume an observed service trace. */
export const views = ["match-market", "scoreboard", "first-reported"] as const;
export const sourceIds = ["match-feed", "bookmaker"];
const identity = (sourceId: string) => ({
  sourceId,
  epoch: "run",
  sourceEntityId: "match-1",
});
const publish = (
  sourceId: string,
  publicationSequence: number,
  type: string,
  payload: object,
  fact?: object,
) => ({
  ...identity(sourceId),
  publicationSequence,
  type,
  payload,
  ...(fact ? { fact } : {}),
});
const fact = (
  sequence: number,
  birth: number,
  revision: number,
  operation: string,
  side: string,
  points: number,
  observedAt: number,
) =>
  publish(
    "match-feed",
    sequence,
    `${side}.contribution`,
    { points, observedAt },
    { birthSequence: birth, revision, operation },
  );
const match = { status: "live", observedAt: 1700000000000, cycle: 1 };
const marketOne = {
  status: "open",
  observedAt: 1700000000100,
  basedOnMatchSequence: 1,
  homeOdds: 2.1,
};
const marketThree = {
  status: "suspended",
  observedAt: 1700000000300,
  basedOnMatchSequence: 6,
  homeOdds: 1.8,
};
const marketFour = {
  status: "open",
  observedAt: 1700000016000,
  basedOnMatchSequence: 8,
  homeOdds: 1.9,
};
export const publications = {
  match: publish("match-feed", 1, "match.state", match),
  marketOne: publish("bookmaker", 1, "market.state", marketOne),
  homeBaseline: fact(2, 2, 1, "create", "home", 0, 1700000000200),
  awayBaseline: fact(3, 3, 1, "create", "away", 0, 1700000000300),
  correction: fact(5, 4, 2, "revise", "home", 2, 1700000000500),
  goal: fact(4, 4, 1, "create", "home", 1, 1700000000400),
  withdrawal: publish(
    "match-feed",
    6,
    "home.contribution",
    {},
    { birthSequence: 4, revision: 3, operation: "retract" },
  ),
  marketThree: publish("bookmaker", 3, "market.state", marketThree),
  outside: fact(7, 4, 4, "revise", "home", 3, 1700000000700),
  newBaseline: fact(8, 8, 1, "create", "home", 0, 1700000000800),
  marketFour: publish("bookmaker", 4, "market.state", marketFour),
};
export type PublicationName = keyof typeof publications;
const retained = (
  birthSequence: number,
  revision: number,
  points: number,
  observedAt: number,
) => ({ birthSequence, revision, payload: { points, observedAt } });
const h0 = retained(2, 1, 0, 1700000000200),
  a0 = retained(3, 1, 0, 1700000000300),
  g1 = retained(4, 1, 1, 1700000000400),
  g2 = retained(4, 2, 2, 1700000000500),
  h7 = retained(8, 1, 0, 1700000000800);
// Literal fact collections, scores, retained records and active records.
const factStates = {
  absent: { goals: null, score: null, retained: 0, active: 0 },
  homeZero: { goals: [h0], score: 0, retained: 1, active: 1 },
  awayZero: { goals: [a0], score: 0, retained: 1, active: 1 },
  goal: { goals: [h0, g1], score: 1, retained: 2, active: 2 },
  corrected: { goals: [h0, g2], score: 2, retained: 2, active: 2 },
  withdrawn: { goals: [h0], score: 0, retained: 2, active: 1 },
  retired: { goals: [], score: 0, retained: 0, active: 0 },
  newZero: { goals: [h7], score: 0, retained: 1, active: 1 },
};
type FactState = keyof typeof factStates;
type Row = {
  match: number | null;
  book: number | null;
  market: "marketOne" | "marketThree" | "marketFour" | null;
  watermark: boolean;
  stale: boolean;
  home: [FactState, FactState, FactState];
  away: [FactState, FactState, FactState];
  floors: [number, number, number];
};
const row = (
  match: number | null,
  book: number | null,
  market: Row["market"],
  home: Row["home"],
  away: Row["away"],
  floors: Row["floors"] = [1, 1, 1],
  watermark = false,
  stale = false,
): Row => ({ match, book, market, home, away, floors, watermark, stale });
const absent: Row["away"] = ["absent", "absent", "absent"],
  away: Row["away"] = ["awayZero", "awayZero", "awayZero"],
  zero: Row["home"] = ["homeZero", "homeZero", "homeZero"],
  withdrawn: Row["home"] = ["withdrawn", "withdrawn", "goal"],
  retired: Row["home"] = ["retired", "retired", "retired"];
export const rows = {
  empty: row(null, null, null, absent, absent),
  match: row(1, null, null, absent, absent),
  marketOne: row(1, 1, "marketOne", absent, absent),
  homeBaseline: row(2, 1, "marketOne", zero, absent),
  awayBaseline: row(3, 1, "marketOne", zero, away),
  goal: row(4, 1, "marketOne", ["goal", "goal", "goal"], away),
  corrected: row(5, 1, "marketOne", ["corrected", "corrected", "goal"], away),
  withdrawn: row(6, 1, "marketOne", withdrawn, away),
  marketGap: row(6, 3, "marketThree", withdrawn, away),
  watermark: row(6, 3, "marketThree", withdrawn, away, [1, 1, 1], true),
  marketRetired: row(
    6,
    3,
    "marketThree",
    ["retired", "withdrawn", "goal"],
    ["retired", "awayZero", "awayZero"],
    [7, 1, 1],
    true,
  ),
  scoreboardRetired: row(
    6,
    3,
    "marketThree",
    ["retired", "retired", "goal"],
    ["retired", "retired", "awayZero"],
    [7, 7, 1],
    true,
  ),
  allRetired: row(6, 3, "marketThree", retired, retired, [7, 7, 7], true),
  outside: row(7, 3, "marketThree", retired, retired, [7, 7, 7], true),
  newBaseline: row(
    8,
    3,
    "marketThree",
    ["newZero", "newZero", "newZero"],
    retired,
    [7, 7, 7],
    true,
  ),
  expired: row(
    8,
    3,
    "marketThree",
    ["newZero", "newZero", "newZero"],
    retired,
    [7, 7, 7],
    true,
    true,
  ),
  refreshed: row(
    8,
    4,
    "marketFour",
    ["newZero", "newZero", "newZero"],
    retired,
    [7, 7, 7],
    true,
  ),
};
export type StateName = keyof typeof rows;
export type PublicState = {
  viewId: string;
  entityId: string;
  version?: number;
  type?: string;
  data: Record<string, unknown>;
  provenance: Record<string, unknown>;
  publicationSequences: Record<string, number[]>;
  status: {
    publication: string;
    missingFields: string[];
    missingRequiredFields: string[];
    fields: Record<
      string,
      {
        freshness: string;
        receivedAtMillis?: number | null;
        inputs: string[];
        facts?: {
          minimumBirthSequence: number;
          retainedCount: number;
          activeCount: number;
        };
      }
    >;
    inputs: Record<string, unknown>;
  };
};
export function expectedState(
  name: StateName,
  view: (typeof views)[number],
): PublicState {
  const r = rows[name],
    index = views.indexOf(view),
    home = factStates[r.home[index]],
    away = factStates[r.away[index]];
  const names =
    view === "match-market"
      ? ["awayGoals", "awayScore", "homeGoals", "homeScore", "market", "match"]
      : view === "scoreboard"
        ? ["awayScore", "homeScore", "match"]
        : ["awayGoals", "awayScore", "homeGoals", "homeScore", "match"];
  const data: Record<string, unknown> = {},
    provenance: Record<string, unknown> = {},
    sequences: Record<string, number[]> = {},
    fields: PublicState["status"]["fields"] = {};
  for (const field of names) {
    const facts = field.startsWith("home")
      ? home
      : field.startsWith("away")
        ? away
        : null;
    const present = facts
      ? facts.score !== null
      : field === "market"
        ? r.market !== null
        : r.match !== null;
    const source = field === "market" ? "bookmaker" : "match-feed";
    if (present) {
      data[field] = facts
        ? field.endsWith("Goals")
          ? facts.goals
          : facts.score
        : field === "market"
          ? publications[r.market!].payload
          : match;
      provenance[field] = identity(source);
      if (!facts)
        sequences[field] = [
          field === "market" ? publications[r.market!].publicationSequence : 1,
        ];
    }
    fields[field] = {
      freshness: !present
        ? "absent"
        : field === "market"
          ? r.stale
            ? "stale"
            : "fresh"
          : "unspecified",
      inputs: [source],
      ...(facts
        ? {
            facts: {
              minimumBirthSequence: r.floors[index],
              retainedCount: facts.retained,
              activeCount: facts.active,
            },
          }
        : {}),
    };
  }
  const input = (source: string, through: number | null) => ({
    state: through === null ? "notObserved" : "observed",
    mode: "contiguousSequence",
    epoch: "run",
    sourceEntityId: "match-1",
    startSequence: 1,
    observedThrough: through,
    watermarkThrough: source === "bookmaker" && r.watermark ? 3 : null,
    completeThrough: null,
    completeness:
      source === "bookmaker" && r.watermark ? "incomplete" : "unknown",
    admissionFloor: through === null ? null : 1,
    sourceContractViolated: false,
    missingRanges:
      source === "bookmaker" && through !== null && through >= 3
        ? [
            {
              from: 2,
              through: 2,
              status: r.watermark ? "confirmed" : "provisional",
            },
          ]
        : [],
  });
  const missingFields = names.filter((field) => !(field in data));
  return {
    viewId: view,
    entityId: "match-1",
    data,
    provenance,
    publicationSequences: sequences,
    status: {
      publication: missingFields.length ? "partial" : "ready",
      missingFields,
      missingRequiredFields: [],
      fields,
      inputs: {
        "match-feed": input("match-feed", r.match),
        ...(view === "match-market"
          ? { bookmaker: input("bookmaker", r.book) }
          : {}),
      },
    },
  };
}
export function projectState(value: PublicState) {
  const copy = structuredClone(value);
  delete copy.version;
  delete copy.type;
  for (const field of Object.values(copy.status.fields))
    delete field.receivedAtMillis;
  return copy;
}
export function projectReceipt(value: Record<string, unknown>) {
  const copy = { ...value };
  delete copy.version;
  return copy;
}
export const exclusions = {
  version:
    "Real market expiry allocates independently timed global versions; exact publication retries retain their original committed version.",
  "status.fields.*.receivedAtMillis":
    "Actual receipt samples use the service clock; deadline, unchanged-sample and refresh relations are separately checked.",
  type: "HTTP has no view-update envelope.",
  frameOrderAndCount:
    "Named per-subscription states are compared; real cross-socket timing and frame count are not a virtual trace.",
};
const factFields = (view: string, side: string) =>
  view === "scoreboard" ? [`${side}Score`] : [`${side}Goals`, `${side}Score`];
export function expectedReceipt(
  name: PublicationName,
  mode: "ordinary" | "unknown" | "duplicate" | "outside" = "ordinary",
) {
  const body = publications[name],
    side = body.type.split(".")[0],
    factInput = side === "home" || side === "away";
  const rejected = mode === "unknown",
    reason =
      mode === "unknown"
        ? "unknownFact"
        : mode === "outside"
          ? "factOutsideRetention"
          : null;
  const targets =
    mode === "unknown" || body.sourceId === "bookmaker"
      ? ["match-market"]
      : [...views];
  return {
    status: rejected
      ? "rejected"
      : mode === "duplicate"
        ? "duplicate"
        : "committed",
    reason: rejected
      ? reason
      : mode === "duplicate"
        ? "alreadyCommitted"
        : "sqlite",
    stream: identity(body.sourceId),
    publicationSequence: body.publicationSequence,
    changedViews: rejected || mode === "duplicate" ? [] : targets,
    targets: targets.map((viewId) => {
      const rejection =
        mode === "unknown" || mode === "outside"
          ? reason
          : factInput &&
              viewId === "first-reported" &&
              ["correction", "withdrawal"].includes(name)
            ? "factImmutable"
            : null;
      const fields =
        mode === "unknown"
          ? ["homeGoals"]
          : factInput
            ? factFields(viewId, side)
            : [side];
      const changed = (field: string) =>
        !rejection && (name !== "newBaseline" || field === "homeGoals");
      return {
        viewId,
        entityId: "match-1",
        status: rejection ? "rejected" : "accepted",
        reason: rejection,
        changedFields: fields.filter(changed),
        fields: fields.map((field) => ({
          field,
          status: rejection ? "rejected" : "accepted",
          reason: rejection,
          changed: changed(field),
        })),
      };
    }),
  };
}
export const watermark = {
  sourceId: "bookmaker",
  epoch: "run",
  sourceEntityId: "match-1",
  throughSequence: 3,
};
export const watermarkReceipt = {
  kind: "watermark",
  status: "committed",
  reason: "sqlite",
  stream: identity("bookmaker"),
  throughSequence: 3,
  changedViews: ["match-market"],
};
export function retirement(view: (typeof views)[number], invalid = false) {
  return {
    viewId: view,
    entityId: "match-1",
    fields: invalid
      ? ["homeScore", "missing"]
      : view === "scoreboard"
        ? ["awayScore", "homeScore"]
        : ["awayGoals", "awayScore", "homeGoals", "homeScore"],
    minimumBirthSequence: 7,
  };
}
export function retirementReceipt(
  view: (typeof views)[number],
  status = "committed",
) {
  const control = retirement(view, status === "rejected");
  return {
    kind: "factRetirement",
    status,
    reason: status === "rejected" ? "unknownFactField" : null,
    control,
    floors:
      status === "rejected"
        ? {}
        : Object.fromEntries(control.fields.map((field) => [field, 7])),
    changedViews: status === "committed" ? [view] : [],
  };
}
