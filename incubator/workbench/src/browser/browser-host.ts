import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import { createBrowserRun, type BrowserRun } from "./browser-run.js";

export type BrowserControlAction =
  | "step"
  | "reset"
  | "play"
  | "pause"
  | "disconnect"
  | "reconnect"
  | "interrupt"
  | "restore";

export type BrowserControlHandler = (
  action: BrowserControlAction,
  runId: string,
) => Promise<void>;

export interface DataConnectionFault {
  runId: string;
  clientId: string;
  action: "break" | "restore";
}

export interface BrowserHostOptions {
  application: BrowserApplication;
  onControl?: BrowserControlHandler;
}

export interface BrowserApplication {
  clientId: string;
  /** Optional HTTPS origins for external images; scripts and data stay local. */
  imageOrigins?: readonly string[];
  /** Exact URL paths mapped to content type and bytes; no filesystem routing. */
  assets: ReadonlyMap<string, readonly [string, Buffer]>;
}

/** Stable local application host; replacing a run preserves its registered control socket. */
export async function startApplicationHost(options: BrowserHostOptions) {
  const { clientId, assets } = options.application;
  const imageOrigins = (options.application.imageOrigins ?? []).map((value) => {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.origin !== value)
      throw new Error("Image origins must be exact HTTPS origins.");
    return url.origin;
  });
  const registrationToken = randomUUID();
  const controller = new AbortController();
  const sockets = new Set<Socket>();
  const controlServer = new WebSocketServer({
    noServer: true,
    maxPayload: 16_384,
  });
  let active: BrowserRun | undefined;
  let registered: WebSocket | undefined;
  let closing: Promise<void> | undefined;
  let replacing = false;
  let retiring: Promise<void> | undefined;
  let origin = "";
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
        "Content-Security-Policy": `default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' ${imageOrigins.join(" ")}; frame-ancestors 'none'`,
        "X-Content-Type-Options": "nosniff",
      })
      .end(asset[1]);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("error", () => socket.destroy());
    socket.on("close", () => sockets.delete(socket));
  });
  controlServer.on("connection", (socket) => {
    const deadline = setTimeout(() => socket.terminate(), 5_000);
    socket.on("error", () => socket.terminate());
    socket.on("close", () => {
      clearTimeout(deadline);
      if (registered === socket && !closing)
        active?.fail("Browser control connection lost.");
    });
    socket.on("message", (data, binary) => {
      try {
        if (binary) throw new Error();
        const message = JSON.parse(data.toString());
        if (!message || typeof message !== "object") throw new Error();
        if (registered === socket) {
          active?.receive(message);
        } else if (
          !registered &&
          active &&
          message.type === "register" &&
          message.runId === active.runId &&
          message.clientId === clientId &&
          message.protocolVersion === 1 &&
          message.token === registrationToken
        ) {
          registered = socket;
          clearTimeout(deadline);
          active.announce("registered");
        } else throw new Error();
      } catch {
        socket.close(1008, "Invalid control message.");
      }
    });
  });
  server.on("upgrade", (request, socket, head) => {
    const reject = () =>
      socket.end("HTTP/1.1 403 Rejected\r\nConnection: close\r\n\r\n");
    if (
      closing ||
      request.headers.host !== new URL(origin).host ||
      request.headers.origin !== origin
    ) {
      reject();
      return;
    }
    const path = new URL(request.url ?? "/", origin);
    if (path.pathname === "/control" && !path.search && !registered && active) {
      controlServer.handleUpgrade(request, socket, head, (client) =>
        controlServer.emit("connection", client),
      );
      return;
    }
    if (!active?.ready || request.url !== active.dataPath) {
      reject();
      return;
    }
    active.upgrade(request, socket, head);
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
  server.on("error", () => {
    active?.fail("Browser host failed.");
    controller.abort(new Error("Browser host failed."));
  });

  return {
    origin,
    signal: controller.signal,
    get pageUrl() {
      if (!active) throw new Error("Bind a run before opening a browser.");
      return `${origin}/#${new URLSearchParams({ runId: active.runId, clientId, token: registrationToken })}`;
    },
    async replaceRun(baseUrl: string): Promise<BrowserRun> {
      if (closing || controller.signal.aborted)
        throw new Error("Browser host closed.");
      if (replacing) throw new Error("Run replacement already in progress.");
      replacing = true;
      try {
        const previous = active;
        active = undefined;
        retiring = previous?.close();
        await retiring;
        if (closing) throw new Error("Browser host closed.");
        const run = createBrowserRun(baseUrl, {
          clientId,
          onControl: options.onControl,
          send(message) {
            if (active !== run || registered?.readyState !== WebSocket.OPEN)
              return false;
            registered.send(JSON.stringify(message));
            return true;
          },
        });
        active = run;
        if (registered) run.announce("run-changed");
        return run;
      } finally {
        replacing = false;
      }
    },
    close(): Promise<void> {
      return (closing ??= (async () => {
        controller.abort(new Error("Browser host closed."));
        await retiring;
        await active?.close();
        for (const socket of controlServer.clients) socket.terminate();
        for (const socket of sockets) socket.destroy();
        await Promise.all([
          new Promise<void>((resolve) => controlServer.close(() => resolve())),
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
        ]);
      })());
    },
  };
}

export type ApplicationHost = Awaited<ReturnType<typeof startApplicationHost>>;

/** Convenience composition for the existing one-host-per-owned-browser mode. */
export async function startBrowserHost(
  baseUrl: string,
  options: BrowserHostOptions,
) {
  const host = await startApplicationHost(options);
  try {
    const run = await host.replaceRun(baseUrl);
    return {
      ...run,
      get ready() {
        return run.ready;
      },
      origin: host.origin,
      pageUrl: host.pageUrl,
      close: host.close,
    };
  } catch (error) {
    await host.close();
    throw error;
  }
}
