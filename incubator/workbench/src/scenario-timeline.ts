import type { ScenarioTimelineEntry } from "./scenario-model.js";
import {
  isClientState,
  isRecord,
  requiredString,
} from "./scenario-validation.js";
import { parseView } from "./scenario-view.js";

type TimedEntry = Record<string, unknown> & { simulationTime: number };
interface References {
  sourceIds: Set<string>;
  clientIds: Set<string>;
  viewIds: Set<string>;
  runtimeViewIds: Set<string>;
}

export function parseTimeline(
  input: unknown[],
  sourceIds: Set<string>,
  clientIds: Set<string>,
  viewIds: Set<string>,
): ScenarioTimelineEntry[] {
  const runtimeViewIds = new Set<string>();
  for (const [index, entry] of input.entries()) {
    if (!isRecord(entry) || entry.kind !== "view-definition") {
      continue;
    }

    const viewId = requiredString(entry.id, `timeline[${index}].id`);
    if (viewIds.has(viewId) || runtimeViewIds.has(viewId)) {
      throw new Error(`View id "${viewId}" is declared more than once.`);
    }
    runtimeViewIds.add(viewId);
  }

  const references = { sourceIds, clientIds, viewIds, runtimeViewIds };
  return input.map((entry, index) => {
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

    const timedEntry = { ...entry, simulationTime: entry.simulationTime };
    if (entry.kind === "client-state")
      return parseClientState(timedEntry, index, references);

    if (entry.kind === "client-subscription")
      return parseClientSubscription(timedEntry, index, references);

    if (entry.kind === "client-view-check")
      return parseClientViewCheck(timedEntry, index, references);

    if (entry.kind === "view-definition")
      return parseViewDefinition(timedEntry, index, references);

    if (entry.kind === "view-check")
      return parseViewCheck(timedEntry, index, references);

    if (entry.kind !== "source-event") {
      throw new Error(
        `Expected timeline[${index}].kind to be "source-event", "client-state", "client-subscription", "client-view-check", "view-definition", or "view-check".`,
      );
    }

    return parseSourceEvent(timedEntry, index, references);
  });
}

function parseClientState(
  entry: TimedEntry,
  index: number,
  { clientIds }: References,
): ScenarioTimelineEntry {
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
    throw new Error(`Expected timeline[${index}].state to be a client state.`);
  }

  return {
    kind: "client-state",
    simulationTime: entry.simulationTime,
    clientId,
    state: entry.state,
  };
}

function parseClientSubscription(
  entry: TimedEntry,
  index: number,
  { clientIds, viewIds, runtimeViewIds }: References,
): ScenarioTimelineEntry {
  const clientId = requiredString(
    entry.clientId,
    `timeline[${index}].clientId`,
  );
  if (!clientIds.has(clientId)) {
    throw new Error(
      `timeline[${index}] refers to unknown client "${clientId}".`,
    );
  }
  if (entry.action !== "subscribe" && entry.action !== "unsubscribe") {
    throw new Error(
      `Expected timeline[${index}].action to be "subscribe" or "unsubscribe".`,
    );
  }

  const viewId = requiredString(entry.viewId, `timeline[${index}].viewId`);
  if (!viewIds.has(viewId) && !runtimeViewIds.has(viewId)) {
    throw new Error(`timeline[${index}] refers to unknown view "${viewId}".`);
  }

  return {
    kind: "client-subscription",
    simulationTime: entry.simulationTime,
    clientId,
    action: entry.action,
    viewId,
    entityId: requiredString(entry.entityId, `timeline[${index}].entityId`),
  };
}

function parseClientViewCheck(
  entry: TimedEntry,
  index: number,
  { clientIds, viewIds, runtimeViewIds }: References,
): ScenarioTimelineEntry {
  const clientId = requiredString(
    entry.clientId,
    `timeline[${index}].clientId`,
  );
  if (!clientIds.has(clientId)) {
    throw new Error(
      `timeline[${index}] refers to unknown client "${clientId}".`,
    );
  }

  const viewId = requiredString(entry.viewId, `timeline[${index}].viewId`);
  if (!viewIds.has(viewId) && !runtimeViewIds.has(viewId)) {
    throw new Error(`timeline[${index}] refers to unknown view "${viewId}".`);
  }
  if (!isRecord(entry.expected)) {
    throw new Error(`Expected timeline[${index}].expected to be an object.`);
  }

  return {
    kind: "client-view-check",
    simulationTime: entry.simulationTime,
    clientId,
    viewId,
    entityId: requiredString(entry.entityId, `timeline[${index}].entityId`),
    expected: entry.expected,
  };
}

function parseViewDefinition(
  entry: TimedEntry,
  index: number,
  { sourceIds }: References,
): ScenarioTimelineEntry {
  const view = parseView(entry, `timeline[${index}]`, sourceIds);
  return {
    kind: "view-definition",
    simulationTime: entry.simulationTime,
    ...view,
  };
}

function parseViewCheck(
  entry: TimedEntry,
  index: number,
  { viewIds, runtimeViewIds }: References,
): ScenarioTimelineEntry {
  const viewId = requiredString(entry.viewId, `timeline[${index}].viewId`);
  if (!viewIds.has(viewId) && !runtimeViewIds.has(viewId)) {
    throw new Error(`timeline[${index}] refers to unknown view "${viewId}".`);
  }
  const entityId = requiredString(
    entry.entityId,
    `timeline[${index}].entityId`,
  );
  if (entry.expected !== null && !isRecord(entry.expected)) {
    throw new Error(`Expected timeline[${index}].expected to be an object.`);
  }

  return {
    kind: "view-check",
    simulationTime: entry.simulationTime,
    viewId,
    entityId,
    expected: entry.expected,
  };
}

function parseSourceEvent(
  entry: TimedEntry,
  index: number,
  { sourceIds }: References,
): ScenarioTimelineEntry {
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
}
