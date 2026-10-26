import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { TestContext } from "node:test";

export async function localService(
  t: TestContext,
  handler: Parameters<typeof createServer>[0],
) {
  const server = createServer(handler);
  const sockets = new Set<import("node:net").Socket>();

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );

  const address = server.address();

  assert.ok(address && typeof address !== "string");

  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

/** Complete only the handshake and close exchange needed by these ownership tests. */
export function acceptWebSocket(req: IncomingMessage, socket: Duplex) {
  const accept = createHash("sha1")
    .update(
      `${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`,
    )
    .digest("base64");
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  socket.on("data", (data: Buffer) => {
    if ((data[0] & 15) === 8) socket.end(Buffer.from([0x88, 0]));
  });
}
