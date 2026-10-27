import { createServer } from "node:http";
import { isIP, type Socket } from "node:net";
import type { BrowserApplication } from "./browser-host.js";

/** Exact asset serving and network boundary shared by owned and external hosts. */
export async function startBrowserHttpServer(
  application: BrowserApplication,
  bindAddress = "127.0.0.1",
) {
  if (isIP(bindAddress) !== 4 || bindAddress === "0.0.0.0")
    throw new Error("Bind to an explicit local IPv4 address, not a wildcard.");
  const imageOrigins = (application.imageOrigins ?? []).map((value) => {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.origin !== value)
      throw new Error("Image origins must be exact HTTPS origins.");
    return url.origin;
  });
  const sockets = new Set<Socket>();
  let origin = "";
  let closing: Promise<void> | undefined;
  const server = createServer((request, response) => {
    if (request.headers.host !== new URL(origin).host) {
      response.writeHead(403).end();
      return;
    }
    const asset = application.assets.get(request.url ?? "");
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
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, bindAddress, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Host has no local port.");
  origin = `http://${bindAddress}:${address.port}`;
  return {
    origin,
    server,
    accepts(request: { headers: { host?: string; origin?: string } }) {
      return (
        !closing &&
        request.headers.host === new URL(origin).host &&
        request.headers.origin === origin
      );
    },
    close() {
      return (closing ??= (async () => {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      })());
    },
  };
}
