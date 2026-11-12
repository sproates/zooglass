import { once } from "node:events";
import { closeClient, connectClient } from "./sockets.js";

/** Only transport uncertainty is safe to retry for an idempotent control. */
export class ControlTransportError extends Error {}
export type ControlExchange = (
  path: string,
  control: object,
) => Promise<unknown>;

export function controlExchange(
  baseUrl: string,
  signal: AbortSignal,
): ControlExchange {
  return async (path, control) => {
    let socket: WebSocket | undefined;
    const lifetime = new AbortController();
    const requestSignal = AbortSignal.any([
      signal,
      lifetime.signal,
      AbortSignal.timeout(5000),
    ]);
    let reply: Promise<unknown[]> | undefined;
    try {
      const url = new URL(path, baseUrl);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      socket = await connectClient(url.href, requestSignal, false);
      socket.addEventListener("close", () => lifetime.abort(), { once: true });
      reply = once(socket, "message", { signal: requestSignal });
      socket.send(JSON.stringify(control));
      const [message] = (await reply) as [MessageEvent];
      return JSON.parse(message.data);
    } catch (cause) {
      signal.throwIfAborted();
      throw new ControlTransportError(
        `No usable acknowledgement from ${path}.`,
        { cause },
      );
    } finally {
      lifetime.abort();
      await reply?.catch(() => {});
      await closeClient(socket);
    }
  };
}
