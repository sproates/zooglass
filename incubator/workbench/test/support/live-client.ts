import assert from "node:assert/strict";
import { once } from "node:events";
import { WebSocket } from "ws";

export type Message = {
  type: string;
  viewId: string;
  entityId: string;
  data?: { position: { sequence: number; padding?: string } };
};

/** One ordered inbox per real socket. Never skip unexpected messages. */
export async function liveClient(baseUrl: string, path = "/views/live") {
  const socket = new WebSocket(baseUrl.replace("http:", "ws:") + path, {
    perMessageDeflate: false,
  });
  const inbox: Message[] = [];
  let wake: (() => void) | undefined;
  socket.on("message", (data) => {
    inbox.push(JSON.parse(data.toString()) as Message);
    wake?.();
  });
  const closed = new Promise<number>((resolve) =>
    socket.once("close", resolve),
  );
  socket.on("close", () => wake?.());
  try {
    await once(socket, "open", { signal: AbortSignal.timeout(5000) });
  } catch (error) {
    socket.terminate();
    await closed;
    throw error;
  }
  const next = async (): Promise<Message> => {
    if (!inbox.length) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Timed out waiting for live message")),
          5000,
        );
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      wake = undefined;
    }
    assert.ok(inbox.length, "socket closed before expected message");
    return inbox.shift()!;
  };
  const send = (message: unknown) =>
    new Promise<void>((resolve, reject) => {
      socket.send(JSON.stringify(message), (error) =>
        error ? reject(error) : resolve(),
      );
    });
  return {
    socket,
    next,
    send,
    closed,
    async subscription(entityId: string, action = "subscribe") {
      await send({ action, viewId: "position", entityId });
      assert.deepEqual(await next(), {
        type: `${action}d`,
        viewId: "position",
        entityId,
      });
    },
    async close() {
      socket.terminate();
      await closed;
    },
  };
}

export function positionEvent(
  entityId: string,
  sequence: number,
  padding = "",
) {
  return {
    sourceId: "feed",
    type: "position",
    entityId,
    payload: { sequence, padding },
  };
}
