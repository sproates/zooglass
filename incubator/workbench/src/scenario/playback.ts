import type {
  Scenario,
  ScenarioDataConnectionFault,
  ScenarioClientStateChange,
  ScenarioClientSubscription,
  ScenarioClientViewCheck,
  ScenarioSourceEvent,
  ScenarioViewDefinition,
  ScenarioViewCheck,
} from "./scenario.js";

export interface SourceEventTraceEntry extends ScenarioSourceEvent {
  sourceName: string;
}

export interface ClientStateTraceEntry extends ScenarioClientStateChange {
  clientName: string;
}

export interface ClientSubscriptionTraceEntry extends ScenarioClientSubscription {
  clientName: string;
}

export interface ClientViewCheckTraceEntry extends ScenarioClientViewCheck {
  clientName: string;
}

export interface ClientInitialStateTraceEntry {
  kind: "client-initial-state";
  simulationTime: 0;
  clientId: string;
  clientName: string;
  state: Scenario["clients"][number]["initialState"];
}

export type ViewCheckTraceEntry = ScenarioViewCheck;

export type ViewDefinitionTraceEntry = ScenarioViewDefinition;

export interface DataConnectionFaultTraceEntry extends ScenarioDataConnectionFault {
  clientName: string;
}

export type TraceEntry =
  | DataConnectionFaultTraceEntry
  | SourceEventTraceEntry
  | ClientStateTraceEntry
  | ClientSubscriptionTraceEntry
  | ClientViewCheckTraceEntry
  | ClientInitialStateTraceEntry
  | ViewDefinitionTraceEntry
  | ViewCheckTraceEntry;

function isSourceEvent(entry: TraceEntry): entry is SourceEventTraceEntry {
  return entry.kind === "source-event";
}

export function playScenario(scenario: Scenario): TraceEntry[] {
  const sourceNames = new Map(
    scenario.sources.map((source) => [source.id, source.name]),
  );
  const clientNames = new Map(
    scenario.clients.map((client) => [client.id, client.name]),
  );

  const initialClientStates: ClientInitialStateTraceEntry[] =
    scenario.clients.map((client) => ({
      kind: "client-initial-state",
      simulationTime: 0,
      clientId: client.id,
      clientName: client.name,
      state: client.initialState,
    }));

  const scheduledEntries = scenario.timeline.map((entry): TraceEntry => {
    if (entry.kind === "source-event") {
      return {
        ...entry,
        sourceName: sourceNames.get(entry.sourceId) ?? entry.sourceId,
      };
    }

    if (entry.kind === "view-check" || entry.kind === "view-definition") {
      return entry;
    }

    return {
      ...entry,
      clientName: clientNames.get(entry.clientId) ?? entry.clientId,
    };
  });

  return [...initialClientStates, ...scheduledEntries]
    .map((entry, declarationOrder) => ({ entry, declarationOrder }))
    .sort(
      (left, right) =>
        left.entry.simulationTime - right.entry.simulationTime ||
        left.declarationOrder - right.declarationOrder,
    )
    .map(({ entry }) => entry);
}

export function formatTraceEntry(entry: TraceEntry): string {
  const time = `+${entry.simulationTime}ms`.padEnd(8);

  if (isSourceEvent(entry)) {
    return `${time} ${entry.sourceName} (${entry.sourceId})  ${entry.type}  ${entry.entityId}  ${JSON.stringify(entry.payload)}`;
  }

  if (entry.kind === "data-connection-fault")
    return `${time} ${entry.action} data route for ${entry.clientName}`;

  if (entry.kind === "client-initial-state") {
    return `${time} Client ${entry.clientName} (${entry.clientId}) starts ${entry.state}`;
  }

  if (entry.kind === "view-check") {
    const expectation =
      entry.expected === null ? "not present" : JSON.stringify(entry.expected);
    return `${time} Check view ${entry.viewId} (${entry.entityId})  ${expectation}`;
  }

  if (entry.kind === "view-definition") {
    return `${time} Define view ${entry.id}`;
  }

  if (entry.kind === "client-subscription") {
    return `${time} Client ${entry.clientName} ${entry.action}s ${entry.viewId} (${entry.entityId})`;
  }

  if (entry.kind === "client-view-check") {
    return `${time} Check ${entry.clientName} received ${entry.viewId} (${entry.entityId})  ${JSON.stringify(entry.expected)}`;
  }

  return `${time} Client ${entry.clientName} (${entry.clientId})  ${entry.state}`;
}
