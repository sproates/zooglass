import assert from "node:assert/strict";
import { createServer } from "node:https";
import type { Socket } from "node:net";
import { test } from "node:test";
import { WebSocketServer } from "ws";
import {
  AccessFailure,
  mediaType,
  ProtocolFailure,
  subprotocol,
} from "../src/service/ha/protocol.js";
import { NodeTransport, trustedOrigins } from "../src/service/ha/transport.js";
import { haTls } from "./fixtures/ha-tls.js";

test("candidate origins are explicit, distinct after normalisation, and scoped", () => {
  assert.deepEqual(trustedOrigins(["https://localhost:443/"]), [
    "https://localhost",
  ]);
  for (const origins of [
    [],
    ["https://localhost", "https://localhost/"],
    ["http://example.com"],
    ["https://user:password@localhost"],
    ["https://localhost/path"],
  ]) {
    assert.throws(() => trustedOrigins(origins));
  }
  assert.deepEqual(trustedOrigins(["http://127.0.0.1:8080"], true), [
    "http://127.0.0.1:8080",
  ]);
});

test(
  "Node transport verifies TLS, negotiation, credential scope and finite wire limits",
  { timeout: 30_000 },
  async (t) => {
    const tls = await haTls(t);
    const requests: string[] = [];
    const sockets = new Set<Socket>();
    const server = createServer(tls, (request, response) => {
      requests.push(request.url ?? "");
      assert.equal(request.headers.authorization, "Bearer fixture-viewer");
      assert.equal(request.headers.accept, mediaType);
      switch (request.url) {
        case "/truncated":
          response.writeHead(200, {
            "Content-Type": mediaType,
            "Content-Length": "1000",
          });
          response.write("{");
          setImmediate(() => response.destroy());
          break;
        case "/redirect":
          response.writeHead(302, { Location: "/must-not-follow" }).end();
          break;
        case "/denied":
          response.writeHead(403).end();
          break;
        case "/wrong-type":
          response
            .writeHead(200, { "Content-Type": "application/json" })
            .end("{}");
          break;
        case "/oversize":
          response
            .writeHead(200, { "Content-Type": mediaType })
            .end("x".repeat(1025));
          break;
        case "/invalid-utf8":
          response
            .writeHead(200, { "Content-Type": mediaType })
            .end(Buffer.from([0xff]));
          break;
        default:
          response
            .writeHead(404, { "Content-Type": mediaType })
            .end('{"unchanged":9007199254740993}');
      }
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    const ws = new WebSocketServer({
      noServer: true,
      handleProtocols: (protocols) => protocols.has(subprotocol) && subprotocol,
    });
    let upgradeStatus: number | undefined;
    server.on("upgrade", (request, socket, head) => {
      if (upgradeStatus) {
        socket.end(
          `HTTP/1.1 ${upgradeStatus} Refused\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
        );
        return;
      }
      ws.handleUpgrade(request, socket, head, (client) =>
        ws.emit("connection", client, request),
      );
    });
    let closeCode: number | undefined;
    let wire: "normal" | "binary" | "oversize" = "normal";
    ws.on("connection", (socket, request) => {
      assert.equal(request.headers.authorization, "Bearer fixture-viewer");
      if (closeCode) {
        socket.close(closeCode);
        return;
      }
      if (wire === "binary") {
        socket.send(Buffer.from("binary"));
        return;
      }
      if (wire === "oversize") {
        socket.send("x".repeat(1025));
        return;
      }
      socket.send("hello");
      socket.on("message", (data) => socket.send(data.toString()));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    t.after(async () => {
      for (const client of ws.clients) client.terminate();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      ws.close();
    });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const origin = `https://127.0.0.1:${address.port}`;
    const transport = new NodeTransport({
      origins: [origin],
      ca: tls.cert,
      bearer: "fixture-viewer",
      maxBytes: 1024,
    });
    const signal = () => AbortSignal.timeout(2000);
    assert.throws(() =>
      (transport.origins as string[]).push("https://elsewhere.invalid"),
    );
    assert.equal(
      (await transport.read(origin, "/missing", signal())).body,
      '{"unchanged":9007199254740993}',
    );
    await assert.rejects(
      transport.read(origin, "/redirect", signal()),
      ProtocolFailure,
    );
    assert.ok(!requests.includes("/must-not-follow"));
    await assert.rejects(
      transport.read(origin, "/denied", signal()),
      AccessFailure,
    );
    for (const path of ["/wrong-type", "/oversize", "/invalid-utf8"]) {
      await assert.rejects(
        transport.read(origin, path, signal()),
        ProtocolFailure,
      );
    }
    await assert.rejects(
      transport.read(origin, "/truncated", signal()),
      /Incomplete/,
    );
    assert.throws(
      () => transport.read(origin, "//elsewhere.invalid/", signal()),
      /Untrusted/,
    );
    const untrusted = new NodeTransport({ origins: [origin], maxBytes: 1024 });
    await assert.rejects(
      untrusted.read(origin, "/missing", signal()),
      AccessFailure,
    );
    await assert.rejects(
      untrusted.connect(origin, "/views/live", signal()),
      AccessFailure,
    );
    const channel = await transport.connect(origin, "/views/live", signal());
    assert.equal(await channel.next(signal()), "hello");
    channel.send("exact publication bytes");
    assert.equal(await channel.next(signal()), "exact publication bytes");
    assert.throws(() => channel.send("x".repeat(1025)), ProtocolFailure);
    channel.close();
    for (const variant of ["binary", "oversize"] as const) {
      wire = variant;
      const invalid = await transport.connect(origin, "/views/live", signal());
      await assert.rejects(invalid.next(signal()), ProtocolFailure);
    }
    wire = "normal";
    for (const status of [401, 406]) {
      upgradeStatus = status;
      await assert.rejects(
        transport.connect(origin, "/views/live", signal()),
        status === 401 ? AccessFailure : ProtocolFailure,
      );
    }
    upgradeStatus = undefined;
    for (const code of [1002, 1003, 1008, 1009]) {
      closeCode = code;
      const refused = await transport.connect(origin, "/views/live", signal());
      await assert.rejects(
        refused.next(signal()),
        code === 1008 ? AccessFailure : ProtocolFailure,
      );
    }
  },
);
