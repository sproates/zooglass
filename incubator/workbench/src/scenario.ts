import { readFile } from "node:fs/promises";

export interface ScenarioSource {
  id: string;
  name: string;
}

export interface ScenarioEvent {
  simulationTime: number;
  sourceId: string;
  type: string;
  entityId: string;
  payload: Record<string, unknown>;
}

export interface Scenario {
  name: string;
  sources: ScenarioSource[];
  events: ScenarioEvent[];
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
  if (!Array.isArray(input.events)) {
    throw new Error("Expected events to be an array.");
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

  const events = input.events.map((event, index): ScenarioEvent => {
    if (!isRecord(event)) {
      throw new Error(`Expected events[${index}] to be an object.`);
    }

    if (
      typeof event.simulationTime !== "number" ||
      !Number.isInteger(event.simulationTime) ||
      event.simulationTime < 0
    ) {
      throw new Error(
        `Expected events[${index}].simulationTime to be a non-negative integer.`,
      );
    }

    const sourceId = requiredString(event.sourceId, `events[${index}].sourceId`);
    if (!sourceIds.has(sourceId)) {
      throw new Error(`events[${index}] refers to unknown source "${sourceId}".`);
    }

    if (!isRecord(event.payload)) {
      throw new Error(`Expected events[${index}].payload to be an object.`);
    }

    return {
      simulationTime: event.simulationTime,
      sourceId,
      type: requiredString(event.type, `events[${index}].type`),
      entityId: requiredString(event.entityId, `events[${index}].entityId`),
      payload: event.payload,
    };
  });

  return { name, sources, events };
}

export async function loadScenario(path: string): Promise<Scenario> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read scenario at "${path}": ${message}`);
  }

  let input: unknown;
  try {
    input = JSON.parse(contents);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Scenario at "${path}" is not valid JSON: ${message}`);
  }

  return parseScenario(input);
}
