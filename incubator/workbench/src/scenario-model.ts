export interface ScenarioSource {
  id: string;
  name: string;
}

export type ClientState =
  "connecting" | "connected" | "disconnecting" | "disconnected";

export interface ScenarioClient {
  id: string;
  name: string;
  initialState: ClientState;
}

export interface ScenarioEventMatcher {
  sourceId: string;
  type: string;
}

export type ScenarioOrderingMode = "latestBySequence" | "historyBySequence";

export interface ScenarioOrdering {
  mode: ScenarioOrderingMode;
  sequenceField: string;
}

export interface ScenarioView {
  id: string;
  fields: Record<string, ScenarioEventMatcher[]>;
  ordering?: Record<string, ScenarioOrdering>;
}

export interface ScenarioViewDefinition extends ScenarioView {
  kind: "view-definition";
  simulationTime: number;
}

export interface ScenarioSourceEvent {
  kind: "source-event";
  simulationTime: number;
  sourceId: string;
  type: string;
  entityId: string;
  payload: Record<string, unknown>;
}

export interface ScenarioClientStateChange {
  kind: "client-state";
  simulationTime: number;
  clientId: string;
  state: ClientState;
}

export interface ScenarioClientSubscription {
  kind: "client-subscription";
  simulationTime: number;
  clientId: string;
  action: "subscribe" | "unsubscribe";
  viewId: string;
  entityId: string;
}

export interface ScenarioClientViewCheck {
  kind: "client-view-check";
  simulationTime: number;
  clientId: string;
  viewId: string;
  entityId: string;
  expected: Record<string, unknown>;
}

export interface ScenarioViewCheck {
  kind: "view-check";
  simulationTime: number;
  viewId: string;
  entityId: string;
  expected: Record<string, unknown> | null;
}

export type ScenarioTimelineEntry =
  | ScenarioSourceEvent
  | ScenarioClientStateChange
  | ScenarioClientSubscription
  | ScenarioClientViewCheck
  | ScenarioViewCheck
  | ScenarioViewDefinition;

export interface Scenario {
  name: string;
  sources: ScenarioSource[];
  clients: ScenarioClient[];
  views: ScenarioView[];
  timeline: ScenarioTimelineEntry[];
}
