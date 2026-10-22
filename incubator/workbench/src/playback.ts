import type { Scenario, ScenarioEvent } from "./scenario.js";

export interface TraceEntry extends ScenarioEvent {
  sourceName: string;
}

export function playScenario(scenario: Scenario): TraceEntry[] {
  const sourceNames = new Map(scenario.sources.map((source) => [source.id, source.name]));

  return scenario.events
    .map((event, declarationOrder) => ({
      event,
      declarationOrder,
      sourceName: sourceNames.get(event.sourceId) ?? event.sourceId,
    }))
    .sort(
      (left, right) =>
        left.event.simulationTimeMs - right.event.simulationTimeMs ||
        left.declarationOrder - right.declarationOrder,
    )
    .map(({ event, sourceName }) => ({ ...event, sourceName }));
}

export function formatTraceEntry(entry: TraceEntry): string {
  const time = `+${entry.simulationTimeMs}ms`.padEnd(8);
  return `${time} ${entry.sourceName} (${entry.sourceId})  ${entry.type}  ${entry.entityId}  ${JSON.stringify(entry.payload)}`;
}
