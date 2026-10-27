import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";

/** One run's data proxy. Retirement closes established and pending upgrades. */
export function createBrowserDataRoute(baseUrl: string, signal: AbortSignal) {
  const dataServer = new WebSocketServer({
    noServer: true,
    maxPayload: 1_048_576,
  });
  const upstreams = new Set<WebSocket>();
  const routes = new Map<WebSocket, () => Promise<void>>();
  let dataBlocked = false;
  let changing = false;
  let closing: Promise<void> | undefined;

  function upgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
    const reject = (status: number) =>
      socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\n\r\n`);
    if (dataBlocked || signal.aborted || closing) {
      reject(503);
      return;
    }
    const upstreamUrl = new URL("/views/live", baseUrl);

    upstreamUrl.protocol = upstreamUrl.protocol === "https:" ? "wss:" : "ws:";

    const upstream = new WebSocket(upstreamUrl, {
      origin: new URL(baseUrl).origin,
      handshakeTimeout: 10_000,
      maxPayload: 1_048_576,
    });

    upstreams.add(upstream);

    let downstream: WebSocket | undefined;
    let retired = false;
    const upstreamClosed = new Promise<void>((resolve) =>
      upstream.once("close", resolve),
    );
    const transportClosed = new Promise<void>((resolve) =>
      socket.once("close", resolve),
    );

    const terminate = () => {
      retired = true;
      upstream.terminate();
      downstream?.terminate();
    };

    routes.set(upstream, async () => {
      terminate();
      socket.destroy();
      await Promise.all([upstreamClosed, transportClosed]);
    });
    void Promise.all([upstreamClosed, transportClosed]).then(() =>
      routes.delete(upstream),
    );

    socket.on("close", terminate);
    upstream.on("error", () => {
      if (!downstream) reject(502);

      terminate();
    });
    upstream.on("close", () => {
      upstreams.delete(upstream);
      downstream?.terminate();
      if (!downstream) socket.destroy();
    });
    upstream.on("open", () => {
      if (retired || dataBlocked || socket.destroyed || signal.aborted) {
        terminate();
        return;
      }

      dataServer.handleUpgrade(request, socket, head, (client) => {
        downstream = client;
        client.on("error", terminate);
        client.on("close", terminate);

        // No retained replay buffer: excessive pending output closes this route.
        const relay = (target: WebSocket, data: Buffer, binary: boolean) => {
          if (
            retired ||
            dataBlocked ||
            target.readyState !== WebSocket.OPEN ||
            target.bufferedAmount > 1_048_576
          ) {
            terminate();
            return;
          }

          target.send(data, { binary }, (error) => {
            if (error) terminate();
          });
        };

        client.on("message", (data, binary) =>
          relay(upstream, data as Buffer, binary),
        );
        upstream.on("message", (data, binary) =>
          relay(client, data as Buffer, binary),
        );
      });
    });
  }

  return {
    upgrade,
    async setBlocked(blocked: boolean) {
      signal.throwIfAborted();
      if (changing)
        throw new Error("A data fault operation is already in progress.");
      changing = true;
      try {
        dataBlocked = blocked;
        if (blocked)
          await Promise.all([...routes.values()].map((stop) => stop()));
      } finally {
        changing = false;
      }
    },
    close(): Promise<void> {
      return (closing ??= (async () => {
        dataBlocked = true;
        await Promise.all([...routes.values()].map((stop) => stop()));
        for (const socket of dataServer.clients) socket.terminate();
        for (const socket of upstreams) socket.terminate();
        await new Promise<void>((resolve) => dataServer.close(() => resolve()));
      })());
    },
  };
}
