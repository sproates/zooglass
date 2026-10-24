import { createBrowserClientExecutor } from "./browser-client-executor.js";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { WebSocket, WebSocketServer } from "ws";

/** Local transport host. Command execution and scenario scheduling are separate. */
export async function startBrowserHost(baseUrl: string) {
  const runId = randomUUID();
  const clientId = "rider-app";
  const registrationToken = randomUUID();
  const routeToken = randomUUID();
  const controller = new AbortController();
  const sockets = new Set<Socket>();
  const upstreams = new Set<WebSocket>();
  const controlServer = new WebSocketServer({
    noServer: true,
    maxPayload: 16_384,
  });
  const dataServer = new WebSocketServer({
    noServer: true,
    maxPayload: 1_048_576,
  });
  let registered: WebSocket | undefined;
  let ready = false;
  let closing: Promise<void> | undefined;
  let origin = "";
  const assets = new Map<string, readonly [string, Buffer]>([
    [
      "/",
      [
        "text/html; charset=utf-8",
        await readFile(
          new URL("../../vehicle-tracker/index.html", import.meta.url),
        ),
      ],
    ],
    [
      "/bridge.js",
      [
        "text/javascript; charset=utf-8",
        await readFile(new URL("../browser/bridge.js", import.meta.url)),
      ],
    ],
    [
      "/vehicle-client.js",
      [
        "text/javascript; charset=utf-8",
        await readFile(
          new URL(
            "../../vehicle-tracker/dist/vehicle-client.js",
            import.meta.url,
          ),
        ),
      ],
    ],
    [
      "/view.js",
      [
        "text/javascript; charset=utf-8",
        await readFile(
          new URL("../../vehicle-tracker/dist/view.js", import.meta.url),
        ),
      ],
    ],
    [
      "/vehicle.css",
      [
        "text/css; charset=utf-8",
        await readFile(
          new URL("../../vehicle-tracker/vehicle.css", import.meta.url),
        ),
      ],
    ],
  ] as const);
  const server = createServer((request, response) => {
    if (request.headers.host !== new URL(origin).host) {
      response.writeHead(403).end();
      return;
    }
    const asset = assets.get(request.url ?? "");
    if (request.method !== "GET" || !asset) {
      response.writeHead(404).end();
      return;
    }
    response
      .writeHead(200, {
        "Content-Type": asset[0],
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy":
          "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'",
        "X-Content-Type-Options": "nosniff",
      })
      .end(asset[1]);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("error", () => socket.destroy());
    socket.on("close", () => sockets.delete(socket));
  });
  const fail = (message: string) => controller.abort(new Error(message));
  const client = createBrowserClientExecutor(
    clientId,
    controller.signal,
    (message) => {
      if (!ready || registered?.readyState !== WebSocket.OPEN)
        throw new Error("Browser is not ready.");
      registered.send(JSON.stringify({ ...message, runId, clientId }));
    },
    fail,
  );
  controlServer.on("connection", (socket) => {
    const deadline = setTimeout(() => socket.terminate(), 5_000);
    socket.on("error", () => socket.terminate());
    socket.on("close", () => {
      clearTimeout(deadline);
      if (registered === socket && !closing)
        fail("Browser control connection lost.");
    });
    socket.on("message", (data, binary) => {
      try {
        if (binary) throw new Error();
        const message = JSON.parse(data.toString());
        if (message.runId !== runId || message.clientId !== clientId) {
          if (registered === socket && ready) return;
          throw new Error();
        }
        if (
          !registered &&
          message.type === "register" &&
          message.protocolVersion === 1 &&
          message.token === registrationToken
        ) {
          registered = socket;
          clearTimeout(deadline);
          socket.send(
            JSON.stringify({
              type: "registered",
              runId,
              clientId,
              dataPath: `/views/live?route=${routeToken}`,
            }),
          );
        } else if (
          registered === socket &&
          message.type === "ready" &&
          !ready
        ) {
          ready = true;
        } else if (registered === socket && ready) {
          client.receive(message);
        } else {
          throw new Error();
        }
      } catch {
        socket.close(1008, "Invalid control message.");
      }
    });
  });
  server.on("upgrade", (request, socket, head) => {
    const reject = (status: number) =>
      socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\n\r\n`);
    if (
      closing ||
      request.headers.host !== new URL(origin).host ||
      request.headers.origin !== origin
    ) {
      reject(403);
      return;
    }
    const path = new URL(request.url ?? "/", origin);
    if (path.pathname === "/control" && !path.search && !registered) {
      controlServer.handleUpgrade(request, socket, head, (client) =>
        controlServer.emit("connection", client),
      );
      return;
    }
    if (
      path.pathname !== "/views/live" ||
      path.search !== `?route=${routeToken}` ||
      !ready ||
      controller.signal.aborted
    ) {
      reject(403);
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
    const terminate = () => {
      upstream.terminate();
      downstream?.terminate();
    };
    socket.on("close", terminate);
    upstream.on("error", () => {
      if (!downstream) reject(502);
      terminate();
    });
    upstream.on("close", () => {
      upstreams.delete(upstream);
      downstream?.terminate();
    });
    upstream.on("open", () => {
      if (socket.destroyed || closing || controller.signal.aborted) {
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
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Host has no local port.");
  origin = `http://127.0.0.1:${address.port}`;
  server.on("error", () => fail("Browser host failed."));
  return {
    origin,
    runId,
    clientId,
    signal: controller.signal,
    executor: client.executor,
    pageUrl: `${origin}/#${new URLSearchParams({ runId, clientId, token: registrationToken })}`,
    async waitForReady(signal: AbortSignal, timeoutMs = 15_000) {
      const combined = AbortSignal.any([
        signal,
        controller.signal,
        AbortSignal.timeout(timeoutMs),
      ]);
      while (!ready) {
        combined.throwIfAborted();
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      combined.throwIfAborted();
    },
    close(): Promise<void> {
      if (closing) return closing;
      closing = Promise.resolve().then(async () => {
        controller.abort(new Error("Browser host closed."));
        await client.executor.close();
        for (const client of controlServer.clients) client.terminate();
        for (const client of dataServer.clients) client.terminate();
        for (const upstream of upstreams) upstream.terminate();
        for (const socket of sockets) socket.destroy();
        await Promise.all([
          new Promise<void>((resolve) => controlServer.close(() => resolve())),
          new Promise<void>((resolve) => dataServer.close(() => resolve())),
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
        ]);
      });
      return closing;
    },
  };
}
