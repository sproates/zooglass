/** Literal score/list/count expectations by named domain state. Scores are never summed. */
import { inputs, type PublicationInput } from "./inputs.js";
import { absentSide, type Side } from "./wire.js";
type Spec = [number, number, string[]];
// Score, retained count, explicit active collection references. Null means absent.
type Pair = [Spec | null, Spec | null, Spec | null, Spec | null];
export const factStages = {
  absent: [null, null, null, null],
  homeBaseline: [
    [0, 1, ["home-baseline"]],
    null,
    [0, 1, ["home-baseline"]],
    null,
  ],
  baselines: [
    [0, 1, ["home-baseline"]],
    [0, 1, ["both-baselines"]],
    [0, 1, ["home-baseline"]],
    [0, 1, ["both-baselines"]],
  ],
  firstGoal: [
    [1, 2, ["home-baseline", "first-goal"]],
    [0, 1, ["both-baselines"]],
    [1, 2, ["home-baseline", "first-goal"]],
    [0, 1, ["both-baselines"]],
  ],
  secondGoal: [
    [2, 3, ["home-baseline", "first-goal", "delayed-create"]],
    [0, 1, ["both-baselines"]],
    [2, 3, ["home-baseline", "first-goal", "delayed-create"]],
    [0, 1, ["both-baselines"]],
  ],
  corrected: [
    [2, 3, ["home-baseline", "first-goal", "corrected-scorer"]],
    [0, 1, ["both-baselines"]],
    [2, 3, ["home-baseline", "first-goal", "delayed-create"]],
    [0, 1, ["both-baselines"]],
  ],
  withdrawn: [
    [1, 3, ["home-baseline", "corrected-scorer"]],
    [0, 1, ["both-baselines"]],
    [2, 3, ["home-baseline", "first-goal", "delayed-create"]],
    [0, 1, ["both-baselines"]],
  ],
  awayGoal: [
    [1, 3, ["home-baseline", "corrected-scorer"]],
    [1, 2, ["both-baselines", "away-goal"]],
    [2, 3, ["home-baseline", "first-goal", "delayed-create"]],
    [1, 2, ["both-baselines", "away-goal"]],
  ],
  homeWithdrawn: [
    [0, 3, ["home-baseline"]],
    [1, 2, ["both-baselines", "away-goal"]],
    [2, 3, ["home-baseline", "first-goal", "delayed-create"]],
    [1, 2, ["both-baselines", "away-goal"]],
  ],
  zero: [
    [0, 3, ["home-baseline"]],
    [0, 2, ["both-baselines"]],
    [2, 3, ["home-baseline", "first-goal", "delayed-create"]],
    [1, 2, ["both-baselines", "away-goal"]],
  ],
  extraAway: [
    [1, 3, ["home-baseline", "corrected-scorer"]],
    [2, 3, ["both-baselines", "away-goal", "later-away-goal"]],
    [2, 3, ["home-baseline", "first-goal", "delayed-create"]],
    [2, 3, ["both-baselines", "away-goal", "later-away-goal"]],
  ],
  retired: [
    [0, 0, []],
    [0, 0, []],
    [0, 0, []],
    [0, 0, []],
  ],
  newHomeBaseline: [
    [0, 1, ["home-baseline"]],
    [0, 0, []],
    [0, 1, ["home-baseline"]],
    [0, 0, []],
  ],
} satisfies Record<string, Pair>;
export type FactStage = keyof typeof factStages;
const publications = inputs().filter(
  (input): input is PublicationInput => input.kind === "publication",
);
export function sides(
  stage: FactStage,
  cycle: number,
  entityId: string,
  first: boolean,
  floor: number,
): [Side, Side] {
  const specs = factStages[stage] as Pair;
  const side = (spec: Spec | null): Side => {
    if (!spec) return { ...absentSide, floor };
    const [score, retained, names] = spec;
    const entries = names.map((name) => {
      const input = publications.find(
        (item) =>
          item.cycle === cycle &&
          item.entityId === entityId &&
          item.name === name &&
          item.body.sourceId === "match-feed",
      )!;
      return {
        birthSequence: input.body.fact!.birthSequence,
        revision: input.body.fact!.revision,
        payload: input.body.payload,
      };
    });
    return {
      present: true,
      floor,
      retained,
      active: entries.length,
      score,
      entries,
    };
  };
  return first
    ? [side(specs[2]), side(specs[3])]
    : [side(specs[0]), side(specs[1])];
}
