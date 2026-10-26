import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import { startBrowserHost } from "../src/browser/browser-host.js";

async function fixture() {
  const server = createServer();
  const upstream = new WebSocketServer({ noServer: true });
  const pending = new Set<Socket>();
  let holdUpgrades = false;
  let upgradeReceived = () => {};

  server.on("upgrade", (request, socket, head) => {
    if (holdUpgrades) {
      pending.add(socket);
      socket.on("error", () => socket.destroy());
      socket.on("close", () => pending.delete(socket));
      upgradeReceived();
      return;
    }
    upstream.handleUpgrade(request, socket, head, (client) => {
      client.on("error", () => {});
      client.on("message", (data) => client.send(data));
      upstream.emit("connection", client);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const host = await startBrowserHost(baseUrl, {
    application: { clientId: "reader", assets: new Map() },
  });
  const control = new WebSocket(
    host.origin.replace("http:", "ws:") + "/control",
    { origin: host.origin },
  );
  await once(control, "open");
  const identity = { runId: host.runId, clientId: host.clientId };
  const registered = once(control, "message");
  control.send(
    JSON.stringify({
      ...identity,
      type: "register",
      protocolVersion: 1,
      token: new URLSearchParams(new URL(host.pageUrl).hash.slice(1)).get(
        "token",
      ),
    }),
  );
  const [reply] = await registered;
  const dataUrl =
    host.origin.replace("http:", "ws:") + JSON.parse(reply.toString()).dataPath;
  control.send(JSON.stringify({ ...identity, type: "ready" }));
  await host.waitForReady(new AbortController().signal);

  return {
    host,
    control,
    identity,
    baseUrl,
    upstream,
    connect() {
      const socket = new WebSocket(dataUrl, { origin: host.origin });
      socket.on("error", () => {});
      return socket;
    },
    holdNextUpgrade() {
      holdUpgrades = true;
      return new Promise<void>((resolve) => {
        upgradeReceived = resolve;
      });
    },
    releaseUpgrades() {
      holdUpgrades = false;
    },
    async close() {
      await host.close();
      for (const socket of pending) socket.destroy();
      for (const socket of upstream.clients) socket.terminate();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function echo(socket: WebSocket, value: string) {
  const reply = once(socket, "message");
  socket.send(value);
  assert.equal(String((await reply)[0]), value);
}

test(
  "data fault closes both transports, refuses upgrades and restores only fresh routes",
  { timeout: 15_000 },
  async () => {
    const f = await fixture();
    try {
      const connected = once(f.upstream, "connection");
      const data = f.connect();
      await once(data, "open");
      const [upstream] = await connected;
      await echo(data, "before interruption");

      // This independent source connection must remain usable during the fault.
      const source = new WebSocket(
        f.baseUrl.replace("http:", "ws:") + "/source",
      );
      await once(source, "open");
      const downstreamClosed = once(data, "close");
      const upstreamClosed = once(upstream, "close");
      upstream.send("old route data queued before interruption");
      await f.host.controlDataConnection({ ...f.identity, action: "break" });
      assert.equal((await downstreamClosed)[0], 1006);
      assert.equal((await upstreamClosed)[0], 1006);
      assert.equal(f.host.signal.aborted, false);
      await echo(source, "source continues");

      const status = new Promise<number>((resolve) => {
        const refused = f.connect();
        refused.on("unexpected-response", (_request, response) => {
          resolve(response.statusCode!);
          response.destroy();
          refused.terminate();
        });
      });
      assert.equal(await status, 503);
      const published = once(f.control, "message");
      f.host.publish({ marker: "control remains live" });
      assert.equal(
        JSON.parse(String((await published)[0])).state.marker,
        "control remains live",
      );

      await f.host.controlDataConnection({ ...f.identity, action: "break" });
      await f.host.controlDataConnection({ ...f.identity, action: "restore" });
      const fresh = f.connect();
      await once(fresh, "open");
      await echo(fresh, "fresh route only");
      assert.equal(data.readyState, WebSocket.CLOSED);
    } finally {
      await f.close();
    }
  },
);

test(
  "fault retires a pending upstream handshake and rejects stale run/client commands",
  { timeout: 15_000 },
  async () => {
    const f = await fixture();
    try {
      for (const identity of [
        { ...f.identity, runId: "old-run" },
        { ...f.identity, clientId: "other-client" },
      ]) {
        await assert.rejects(
          f.host.controlDataConnection({ ...identity, action: "break" }),
          /active run and client/,
        );
      }
      const entered = f.holdNextUpgrade();
      const pending = f.connect();
      const closed = new Promise<void>((resolve) =>
        pending.once("close", () => resolve()),
      );
      await entered;
      const breaking = f.host.controlDataConnection({
        ...f.identity,
        action: "break",
      });
      await assert.rejects(
        f.host.controlDataConnection({ ...f.identity, action: "restore" }),
        /already in progress/,
      );
      await breaking;
      await closed;
      f.releaseUpgrades();
      await f.host.controlDataConnection({ ...f.identity, action: "restore" });
      const fresh = f.connect();
      await once(fresh, "open");
      await echo(fresh, "not the retired handshake");
      await f.host.close();
      await assert.rejects(
        f.host.controlDataConnection({ ...f.identity, action: "restore" }),
        /active run and client/,
      );
    } finally {
      await f.close();
    }
  },
);
