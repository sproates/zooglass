/** Fixed clock and explicit producer receipt barriers; no reconciliation or oracle calculation. */
import {
  sportsTimeline,
  type SourcePublication,
  type SportsStep,
} from "./schedule.js";
export const epoch = 1700000000000,
  stepMillis = 3000;
export const views = ["match-market", "scoreboard", "first-reported"];
export const actors = {
  match: "match-source",
  book: "bookmaker-source",
  progress: "sports-progress",
  retirement: "sports-retirement",
  viewer: "sports-viewer",
};
export const factFields = (view: string) =>
  view === "scoreboard"
    ? ["homeScore", "awayScore"]
    : ["homeGoals", "awayGoals", "homeScore", "awayScore"];
export function pinnedSteps(): SportsStep[] {
  let wall = epoch;
  const iterator = sportsTimeline(2, () => wall),
    steps: SportsStep[] = [];
  for (let index = 0; ; index++) {
    wall = epoch + index * stepMillis;
    const next = iterator.next();
    if (next.done) break;
    steps.push(next.value);
  }
  return steps;
}
type Base = {
  step: number;
  cycle: number;
  name: string;
  entityId: string;
  id: string;
  atMs: number;
};
export type Body = Omit<SourcePublication, "entityId" | "expectedRejection"> & {
  sourceEntityId: string;
};
export type PublicationInput = Base & {
  kind: "publication";
  body: Body;
  duplicate: boolean;
  expectedRejection: string | null;
};
export type ProgressInput = Base & {
  kind: "progress";
  control: {
    sourceId: string;
    epoch: string;
    sourceEntityId: string;
    throughSequence: number;
  };
};
export type RetirementInput = Base & {
  kind: "retirement";
  control: {
    viewId: string;
    entityId: string;
    fields: string[];
    minimumBirthSequence: number;
  };
};
export type Input =
  | PublicationInput
  | ProgressInput
  | RetirementInput
  | (Base & { kind: "disconnect" | "reconnect" });
export function inputs() {
  return pinnedSteps().flatMap((step, index) => {
    let slot = 0;
    return step.actions.flatMap<Input>((action) => {
      const base = {
        step: index,
        cycle: step.cycle,
        name: step.name,
        entityId: step.entityId,
      };
      if (action.kind === "retire")
        return views.map((viewId) => ({
          ...base,
          id: `step-${index}-${slot}`,
          atMs: index * stepMillis + 10 + slot++,
          kind: "retirement" as const,
          control: {
            viewId,
            entityId: action.entityId,
            fields: factFields(viewId),
            minimumBirthSequence: action.minimumBirthSequence,
          },
        }));
      const atMs = index * stepMillis + 10 + slot++,
        id = `step-${index}-${slot - 1}`;
      if (action.kind === "publish") {
        const { entityId, expectedRejection, ...event } = action.event;
        return [
          {
            ...base,
            id,
            atMs,
            kind: "publication" as const,
            body: { ...event, sourceEntityId: entityId },
            duplicate: action.duplicate ?? false,
            expectedRejection: expectedRejection ?? null,
          },
        ];
      }
      if (action.kind === "watermark")
        return [
          {
            ...base,
            id,
            atMs,
            kind: "progress" as const,
            control: {
              sourceId: "bookmaker",
              epoch: "run",
              sourceEntityId: action.entityId,
              throughSequence: action.throughSequence,
            },
          },
        ];
      return [{ ...base, id, atMs, kind: action.kind }];
    });
  });
}
