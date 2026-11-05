import type { ScenarioSource, ScenarioView } from "../scenario/scenario.js";

export const scenarioEpoch = "run";

/** Compile scenario declarations to the single service configuration contract. */
export function runtimeView(view: ScenarioView) {
  return {
    id: view.id,
    fields: Object.fromEntries(
      Object.entries(view.fields).map(([name, inputs]) => {
        const ordering =
          view.ordering && Object.hasOwn(view.ordering, name)
            ? view.ordering[name]
            : undefined;
        if (ordering && ordering.sequenceField !== "publicationSequence") {
          throw new Error(
            `Scenario field ${view.id}.${name} must order by publicationSequence.`,
          );
        }
        const sources = [...new Set(inputs.map((input) => input.sourceId))];
        if (sources.length !== 1) {
          throw new Error(
            `Scenario field ${view.id}.${name} must declare one source; shared-source priorities need an explicit runtime policy.`,
          );
        }
        return [
          name,
          {
            ...(inputs.length === 1 ? inputs[0] : { inputs }),
            mode: ordering?.mode ?? "arrival",
          },
        ];
      }),
    ),
  };
}

export function runtimeConfiguration(
  views: ScenarioView[],
  sources: ScenarioSource[] = [],
) {
  const ids = new Set(sources.map((source) => source.id));
  for (const view of views) {
    for (const matchers of Object.values(view.fields)) {
      for (const matcher of matchers) ids.add(matcher.sourceId);
    }
  }
  return {
    contractVersion: 2,
    storage: "memory",
    maxStreams: 100_000,
    identityWindow: 10_000,
    maxHistoryEntries: 10_000,
    sources: [...ids].map((id) => ({ id, epoch: scenarioEpoch })),
    views: views.map(runtimeView),
  };
}
