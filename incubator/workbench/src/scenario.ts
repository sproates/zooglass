import { readFile } from "node:fs/promises";

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

export type ScenarioTimelineEntry =
  ScenarioSourceEvent | ScenarioClientStateChange;

export interface Scenario {
  name: string;
  sources: ScenarioSource[];
  clients: ScenarioClient[];
  timeline: ScenarioTimelineEntry[];
}

const clientStates: ClientState[] = [
  "connecting",
  "connected",
  "disconnecting",
  "disconnected",
];

function isClientState(value: unknown): value is ClientState {
  return clientStates.some((state) => state === value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Expected ${field} to be a non-empty string.`);
  }

  return value;
}

export function parseScenario(input: unknown): Scenario {
  if (!isRecord(input)) {
    throw new Error("Expected the scenario to be a JSON object.");
  }

  const name = requiredString(input.name, "name");
  if (!Array.isArray(input.sources)) {
    throw new Error("Expected sources to be an array.");
  }
  if (!Array.isArray(input.clients)) {
    throw new Error("Expected clients to be an array.");
  }
  if (!Array.isArray(input.timeline)) {
    throw new Error("Expected timeline to be an array.");
  }

  const sources = input.sources.map((source, index): ScenarioSource => {
    if (!isRecord(source)) {
      throw new Error(`Expected sources[${index}] to be an object.`);
    }

    return {
      id: requiredString(source.id, `sources[${index}].id`),
      name: requiredString(source.name, `sources[${index}].name`),
    };
  });

  const sourceIds = new Set<string>();
  for (const source of sources) {
    if (sourceIds.has(source.id)) {
      throw new Error(`Source id "${source.id}" is declared more than once.`);
    }
    sourceIds.add(source.id);
  }

  const clients = input.clients.map((client, index): ScenarioClient => {
    if (!isRecord(client)) {
      throw new Error(`Expected clients[${index}] to be an object.`);
    }

    const initialState = client.initialState;
    if (!isClientState(initialState)) {
      throw new Error(
        `Expected clients[${index}].initialState to be a client state.`,
      );
    }

    return {
      id: requiredString(client.id, `clients[${index}].id`),
      name: requiredString(client.name, `clients[${index}].name`),
      initialState,
    };
  });

  const clientIds = new Set<string>();
  for (const client of clients) {
    if (clientIds.has(client.id)) {
      throw new Error(`Client id "${client.id}" is declared more than once.`);
    }
    clientIds.add(client.id);
  }

  const timeline = input.timeline.map((entry, index): ScenarioTimelineEntry => {
    if (!isRecord(entry)) {
      throw new Error(`Expected timeline[${index}] to be an object.`);
    }

    if (
      typeof entry.simulationTime !== "number" ||
      !Number.isInteger(entry.simulationTime) ||
      entry.simulationTime < 0
    ) {
      throw new Error(
        `Expected timeline[${index}].simulationTime to be a non-negative integer.`,
      );
    }

    if (entry.kind === "client-state") {
      const clientId = requiredString(
        entry.clientId,
        `timeline[${index}].clientId`,
      );
      if (!clientIds.has(clientId)) {
        throw new Error(
          `timeline[${index}] refers to unknown client "${clientId}".`,
        );
      }

      if (!isClientState(entry.state)) {
        throw new Error(
          `Expected timeline[${index}].state to be a client state.`,
        );
      }

      return {
        kind: "client-state",
        simulationTime: entry.simulationTime,
        clientId,
        state: entry.state,
      };
    }

    if (entry.kind !== "source-event") {
      throw new Error(
        `Expected timeline[${index}].kind to be "source-event" or "client-state".`,
      );
    }

    const sourceId = requiredString(
      entry.sourceId,
      `timeline[${index}].sourceId`,
    );
    if (!sourceIds.has(sourceId)) {
      throw new Error(
        `timeline[${index}] refers to unknown source "${sourceId}".`,
      );
    }

    if (!isRecord(entry.payload)) {
      throw new Error(`Expected timeline[${index}].payload to be an object.`);
    }

    return {
      kind: "source-event",
      simulationTime: entry.simulationTime,
      sourceId,
      type: requiredString(entry.type, `timeline[${index}].type`),
      entityId: requiredString(entry.entityId, `timeline[${index}].entityId`),
      payload: entry.payload,
    };
  });

  return { name, sources, clients, timeline };
}

export async function loadScenario(path: string): Promise<Scenario> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read scenario at "${path}": ${message}`, {
      cause: error,
    });
  }

  let input: unknown;
  try {
    input = JSON.parse(contents);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Scenario at "${path}" is not valid JSON: ${message}`, {
      cause: error,
    });
  }

  return parseScenario(input);
}
