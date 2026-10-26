import type { Scenario } from "./scenario.js";
import type { TraceEntry } from "./playback.js";

export function namespaceScenario(scenario: Scenario, index: number): Scenario {
  const namespace = `scenario-${index + 1}`;
  const sourceIds = new Map(
    scenario.sources.map((source) => [source.id, `${namespace}-${source.id}`]),
  );
  const allViews = [
    ...scenario.views,
    ...scenario.timeline.filter(
      (entry): entry is Extract<TraceEntry, { kind: "view-definition" }> =>
        entry.kind === "view-definition",
    ),
  ];
  const viewIds = new Map(
    allViews.map((view) => [view.id, `${namespace}-${view.id}`]),
  );

  const namespaceView = <T extends Scenario["views"][number]>(view: T): T =>
    ({
      ...view,
      id: viewIds.get(view.id)!,
      fields: Object.fromEntries(
        Object.entries(view.fields).map(([name, matchers]) => [
          name,
          matchers.map((matcher) => ({
            ...matcher,
            sourceId: sourceIds.get(matcher.sourceId)!,
          })),
        ]),
      ),
    }) as T;

  return {
    ...scenario,
    sources: scenario.sources.map((source) => ({
      ...source,
      id: sourceIds.get(source.id)!,
    })),
    views: scenario.views.map(namespaceView),
    timeline: scenario.timeline.map((entry) => {
      if (entry.kind === "source-event") {
        return { ...entry, sourceId: sourceIds.get(entry.sourceId)! };
      }

      if (entry.kind === "view-check") {
        return { ...entry, viewId: viewIds.get(entry.viewId)! };
      }

      if (
        entry.kind === "client-subscription" ||
        entry.kind === "client-view-check"
      ) {
        return { ...entry, viewId: viewIds.get(entry.viewId)! };
      }

      if (entry.kind === "view-definition") {
        return namespaceView(entry);
      }

      return entry;
    }),
  };
}
