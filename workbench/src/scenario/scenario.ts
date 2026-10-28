import { readFile } from "node:fs/promises";

import type {
  Scenario,
  ScenarioSource,
  ScenarioClient,
} from "./scenario-model.js";
import {
  isClientState,
  isRecord,
  requiredString,
} from "./scenario-validation.js";
import { parseView } from "./scenario-view.js";
import { parseTimeline } from "./scenario-timeline.js";

export type * from "./scenario-model.js";

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

  const viewsInput = input.views ?? [];

  if (!Array.isArray(viewsInput)) {
    throw new Error("Expected views to be an array.");
  }

  const views = viewsInput.map((view, index) =>
    parseView(view, `views[${index}]`, sourceIds),
  );

  const viewIds = new Set<string>();

  for (const view of views) {
    if (viewIds.has(view.id)) {
      throw new Error(`View id "${view.id}" is declared more than once.`);
    }

    viewIds.add(view.id);
  }

  const timeline = parseTimeline(input.timeline, sourceIds, clientIds, viewIds);

  return { name, sources, clients, views, timeline };
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
