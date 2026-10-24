import { isDeepStrictEqual } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import type { TraceEntry } from "./playback.js";
import type { Scenario, ScenarioClient } from "./scenario.js";
import {
  createNodeClientExecutor,
  type ClientExecutor,
} from "./node-client-executor.js";
import { connectClient, closeClient, closeAll } from "./sockets.js";

async function checkView(
  baseUrl: string,
  check: Extract<TraceEntry, { kind: "view-check" }>,
  signal: AbortSignal,
): Promise<void> {
  const url = `${baseUrl}/views/${encodeURIComponent(check.viewId)}/${encodeURIComponent(check.entityId)}`;
  const startedAt = Date.now();
  let lastActual: unknown = "view not found";

  while (Date.now() - startedAt < 5_000) {
    signal.throwIfAborted();
    let response: Response;
    try {
      response = await fetch(url, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(1_000)]),
      });
    } catch (error) {
      signal.throwIfAborted();
      lastActual = error instanceof Error ? error.message : String(error);
      await delay(25, undefined, { signal });
      continue;
    }

    if (check.expected === null) {
      if (response.status === 404) {
        console.log(
          `View absence check passed: ${check.viewId} (${check.entityId})`,
        );
        return;
      }
      if (response.ok) {
        throw new Error(
          `Expected view ${check.viewId} (${check.entityId}) to be absent, but it was present.`,
        );
      }
      lastActual = `HTTP ${response.status}`;
    } else if (response.ok) {
      const body: unknown = await response.json();
      if (typeof body === "object" && body !== null && "data" in body) {
        lastActual = body.data;
        if (isDeepStrictEqual(body.data, check.expected)) {
          console.log(`View check passed: ${check.viewId} (${check.entityId})`);
          return;
        }
      }
    } else {
      lastActual = `HTTP ${response.status}`;
    }

    await delay(25, undefined, { signal });
  }

  throw new Error(
    `View check failed for ${check.viewId} (${check.entityId}). Expected ${JSON.stringify(check.expected)}, got ${JSON.stringify(lastActual)}.`,
  );
}

async function defineView(
  baseUrl: string,
  entry: Extract<TraceEntry, { kind: "view-definition" }>,
  signal: AbortSignal,
): Promise<void> {
  const response = await fetch(`${baseUrl}/views`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: entry.id,
      fields: entry.fields,
      ordering: entry.ordering,
    }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(1_000)]),
  });

  if (response.status !== 201) {
    throw new Error(
      `Could not define view ${entry.id}: ZooGlass returned HTTP ${response.status}.`,
    );
  }
}

export interface ScenarioSession {
  /** Dispatch one entry, without applying its simulationTime delay. Overlap is rejected. */
  execute(entry: TraceEntry): Promise<void>;
  /** Cancel the active action, close all resources, and wait for cleanup. Idempotent. */
  close(): Promise<void>;
}

export interface ScenarioSessionOptions {
  signal?: AbortSignal;
  /** Called once per declared client. Returned executors belong to this session. */
  createClientExecutor?: (
    client: ScenarioClient,
    liveUrl: string,
  ) => ClientExecutor;
}

export async function openScenarioSession(
  scenario: Scenario,
  baseUrl: string,
  options: ScenarioSessionOptions = {},
): Promise<ScenarioSession> {
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([controller.signal, options.signal])
    : controller.signal;
  const sourceSockets = new Map<string, WebSocket>();
  const executors = new Map<string, ClientExecutor>();
  const socketUrl = (path: string) => {
    const url = new URL(path, baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.href;
  };
  let active: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closing) return closing;
    controller.abort(new Error("Scenario session closed."));
    closing = (async () => {
      // Cancellation must settle before an executor's resources can be disposed.
      await active?.catch(() => {});
      await closeAll([
        ...[...sourceSockets.values()].map(closeClient),
        ...[...new Set(executors.values())].map((executor) =>
          Promise.resolve().then(() => executor.close()),
        ),
      ]);
    })();
    return closing;
  };
  try {
    signal.throwIfAborted();
    for (const client of scenario.clients) {
      const url = socketUrl("/views/live");
      executors.set(
        client.id,
        options.createClientExecutor?.(client, url) ??
          createNodeClientExecutor(url),
      );
    }
    for (const source of scenario.sources) {
      sourceSockets.set(
        source.id,
        await connectClient(socketUrl("/events"), signal),
      );
      console.log(`Connected source ${source.name} (${source.id})`);
    }
    signal.throwIfAborted();
  } catch (error) {
    await close();
    throw error;
  }

  const dispatch = async (entry: TraceEntry) => {
    signal.throwIfAborted();
    if (entry.kind === "source-event") {
      const socket = sourceSockets.get(entry.sourceId);
      if (socket === undefined || socket.readyState !== WebSocket.OPEN) {
        throw new Error(
          `Source ${entry.sourceId} is not connected when its event is scheduled.`,
        );
      }
      socket.send(
        JSON.stringify({
          sourceId: entry.sourceId,
          type: entry.type,
          entityId: entry.entityId,
          payload: entry.payload,
        }),
      );
    } else if (entry.kind === "view-check") {
      await checkView(baseUrl, entry, signal);
    } else if (entry.kind === "view-definition") {
      await defineView(baseUrl, entry, signal);
    } else {
      const executor = executors.get(entry.clientId);
      if (!executor)
        throw new Error(`No executor for client ${entry.clientId}.`);
      await executor.execute(entry, signal);
    }
  };
  return {
    async execute(entry) {
      signal.throwIfAborted();
      if (active) throw new Error("A scenario action is already running.");
      active = dispatch(entry);
      try {
        await active;
      } finally {
        active = undefined;
      }
    },
    close,
  };
}
