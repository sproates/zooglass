import assert from "node:assert/strict";
import { createServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";

// Controlled protocol peer: exercise empty/failed responses that the current
// ZooGlass fixture cannot produce. Real-service rendering has separate coverage.
type Request = { action: string; viewId: string; entityId: string };

export async function peer(
  rejectUpgrade = false,
  onRequest?: (request: Request, acknowledge: () => void) => void,
) {
  const server = createServer();
  const wss = new WebSocketServer({ noServer: true });
  let socket: WebSocket | undefined;

  server.on("upgrade", (request, stream, head) => {
    if (rejectUpgrade) {
      stream.end("HTTP/1.1 503 Unavailable\r\nConnection: close\r\n\r\n");
      return;
    }

    wss.handleUpgrade(request, stream, head, (client) =>
      wss.emit("connection", client),
    );
  });
  wss.on("connection", (client) => {
    socket = client;
    client.on("message", (data) => {
      const request = JSON.parse(data.toString());

      const acknowledge = () =>
        client.send(
          JSON.stringify({
            type:
              request.action === "subscribe" ? "subscribed" : "unsubscribed",
            viewId: request.viewId,
            entityId: request.entityId,
          }),
        );

      if (onRequest) onRequest(request, acknowledge);
      else acknowledge();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const address = server.address();

  assert.ok(address && typeof address !== "string");

  return {
    url: `http://127.0.0.1:${address.port}`,
    raw(message: string) {
      assert.ok(socket);
      socket.send(message);
    },
    snapshot(viewId: string, data: unknown) {
      assert.ok(socket);
      socket.send(
        JSON.stringify({
          type: "view-update",
          viewId,
          entityId: "car-17",
          data,
        }),
      );
    },
    disconnect() {
      socket?.terminate();
    },
    async close() {
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export const signal = () => new AbortController().signal;

const base = { simulationTime: 0, clientId: "rider-app", clientName: "Viewer" };

export const state = (value: "connected" | "disconnected") => ({
  ...base,
  kind: "client-state" as const,
  state: value,
});

export const subscription = (
  viewId: string,
  action: "subscribe" | "unsubscribe" = "subscribe",
) => ({
  ...base,
  kind: "client-subscription" as const,
  viewId,
  entityId: "car-17",
  action,
});

export const position = { sequence: 42, latitude: 51.2, longitude: -0.1 };
