import { isDeepStrictEqual } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import type { TraceEntry } from "../scenario/playback.js";
import {
  connectClient,
  closeClient,
  closeAll,
  messagesBySocket,
} from "./sockets.js";

const messageTimeoutMs = 5_000;

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function waitForClientMessage(
  socket: WebSocket,
  matches: (message: unknown) => boolean,
  description: string,
  signal: AbortSignal,
): Promise<unknown> {
  const messages = messagesBySocket.get(socket);

  if (messages === undefined) {
    throw new Error("No message queue is available for the client connection.");
  }

  const deadline = Date.now() + messageTimeoutMs;

  while (Date.now() < deadline) {
    signal.throwIfAborted();

    const index = messages.findIndex(matches);

    if (index >= 0) {
      return messages.splice(index, 1)[0];
    }

    if (socket.readyState !== WebSocket.OPEN) {
      throw new Error(
        "Client connection closed before the expected message arrived.",
      );
    }

    await delay(10, undefined, { signal });
  }

  throw new Error(`Timed out waiting for ${description}.`);
}

async function applyClientState(
  entry: Extract<TraceEntry, { kind: "client-initial-state" | "client-state" }>,
  url: string,
  sockets: Map<string, WebSocket>,
  signal: AbortSignal,
): Promise<void> {
  if (entry.state === "connecting" || entry.state === "connected") {
    if (!sockets.has(entry.clientId)) {
      sockets.set(entry.clientId, await connectClient(url, signal));
    }

    return;
  }

  const socket = sockets.get(entry.clientId);

  await closeClient(socket);
  sockets.delete(entry.clientId);
}

async function applyClientSubscription(
  entry: Extract<TraceEntry, { kind: "client-subscription" }>,
  sockets: Map<string, WebSocket>,
  signal: AbortSignal,
): Promise<void> {
  const socket = sockets.get(entry.clientId);

  if (socket === undefined || socket.readyState !== WebSocket.OPEN) {
    throw new Error(
      `Client ${entry.clientId} is not connected when its subscription is scheduled.`,
    );
  }

  socket.send(
    JSON.stringify({
      action: entry.action,
      viewId: entry.viewId,
      entityId: entry.entityId,
    }),
  );

  const responseType =
    entry.action === "subscribe" ? "subscribed" : "unsubscribed";

  await waitForClientMessage(
    socket,
    (message) =>
      isJsonObject(message) &&
      message.type === responseType &&
      message.viewId === entry.viewId &&
      message.entityId === entry.entityId,
    `${responseType} response for ${entry.viewId} (${entry.entityId})`,
    signal,
  );
}

async function checkClientView(
  entry: Extract<TraceEntry, { kind: "client-view-check" }>,
  sockets: Map<string, WebSocket>,
  signal: AbortSignal,
): Promise<void> {
  const socket = sockets.get(entry.clientId);

  if (socket === undefined || socket.readyState !== WebSocket.OPEN) {
    throw new Error(
      `Client ${entry.clientId} is not connected when its view update is expected.`,
    );
  }

  await waitForClientMessage(
    socket,
    (message) =>
      isJsonObject(message) &&
      message.type === "view-update" &&
      message.viewId === entry.viewId &&
      message.entityId === entry.entityId &&
      isDeepStrictEqual(message.data, entry.expected),
    `view update for client ${entry.clientId}: ${entry.viewId} (${entry.entityId})`,
    signal,
  );
  console.log(`Client view check passed: ${entry.clientId} (${entry.viewId})`);
}

export type ClientEntry = Exclude<
  Extract<TraceEntry, { clientId: string }>,
  { kind: "data-connection-fault" }
>;

/** Owned by one scenario session. execute must honour cancellation. */
export interface ClientExecutor {
  execute(entry: ClientEntry, signal: AbortSignal): Promise<void>;
  close(): Promise<void>;
}

export function createNodeClientExecutor(url: string): ClientExecutor {
  const sockets = new Map<string, WebSocket>();
  return {
    async execute(entry, signal) {
      signal.throwIfAborted();

      if (entry.kind === "client-subscription") {
        await applyClientSubscription(entry, sockets, signal);
      } else if (entry.kind === "client-view-check") {
        await checkClientView(entry, sockets, signal);
      } else {
        await applyClientState(entry, url, sockets, signal);
      }
    },
    async close() {
      await closeAll([...sockets.values()].map(closeClient));
      sockets.clear();
    },
  };
}
