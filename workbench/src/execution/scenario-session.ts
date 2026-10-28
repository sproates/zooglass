import { checkView, defineView } from "./view-http.js";
import type {
  TraceEntry,
  DataConnectionFaultTraceEntry,
} from "../scenario/playback.js";
import type { Scenario, ScenarioClient } from "../scenario/scenario.js";
import {
  createNodeClientExecutor,
  type ClientExecutor,
} from "./node-client-executor.js";
import { connectClient, closeClient, closeAll } from "./sockets.js";

export interface ScenarioSession {
  /** Dispatch one entry, without applying its simulationTime delay. Overlap is rejected. */
  execute(entry: TraceEntry): Promise<void>;
  /** Cancel the active action, close all resources, and wait for cleanup. Idempotent. */
  close(): Promise<void>;
}

export interface ScenarioSessionOptions {
  signal?: AbortSignal;
  executeDataFault?: (
    entry: DataConnectionFaultTraceEntry,
    signal: AbortSignal,
  ) => Promise<void>;
  /** Called once per declared client. Returned executors belong to this session. */
  createClientExecutor?: (
    client: ScenarioClient,
    liveUrl: string,
  ) => ClientExecutor;
}

export function requireDataFaultSupport(scenario: Scenario, supported = false) {
  if (
    !supported &&
    scenario.timeline.some((entry) => entry.kind === "data-connection-fault")
  )
    throw new Error(
      "This scenario requires browser data-connection-fault support; Node-only execution is unsupported.",
    );
}

export async function openScenarioSession(
  scenario: Scenario,
  baseUrl: string,
  options: ScenarioSessionOptions = {},
): Promise<ScenarioSession> {
  requireDataFaultSupport(scenario, !!options.executeDataFault);
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

    if (entry.kind === "data-connection-fault") {
      if (!options.executeDataFault)
        throw new Error("Data connection faults are unsupported.");
      await options.executeDataFault(entry, signal);
    } else if (entry.kind === "source-event") {
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
