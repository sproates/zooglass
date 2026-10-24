import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { startBrowserSession } from "../../src/browser-session.js";

// Controlled protocol peer: exercise empty/failed responses that the current
// ZooGlass fixture cannot produce. Real-service rendering has separate coverage.
async function peer(rejectUpgrade = false) {
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
      client.send(
        JSON.stringify({
          type: request.action === "subscribe" ? "subscribed" : "unsubscribed",
          viewId: request.viewId,
          entityId: request.entityId,
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    url: `http://127.0.0.1:${address.port}`,
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
const signal = () => new AbortController().signal;
const base = { simulationTime: 0, clientId: "rider-app", clientName: "Viewer" };
const state = (value: "connected" | "disconnected") => ({
  ...base,
  kind: "client-state" as const,
  state: value,
});
const subscription = (
  viewId: string,
  action: "subscribe" | "unsubscribe" = "subscribe",
) => ({
  ...base,
  kind: "client-subscription" as const,
  viewId,
  entityId: "car-17",
  action,
});
const position = { sequence: 42, latitude: 51.2, longitude: -0.1 };

test(
  "independent waiting and empty states, retained data, and fresh snapshots after resubscription",
  { timeout: 30_000 },
  async () => {
    const upstream = await peer();
    try {
      const browser = await startBrowserSession(upstream.url, {
        signal: signal(),
        headless: true,
        keepOpenOnFailure: true,
      });
      try {
        const execute = (
          entry: ReturnType<typeof state> | ReturnType<typeof subscription>,
        ) => browser.host.executor.execute(entry, signal());
        await execute(state("connected"));
        await execute(subscription("live-map"));
        await execute(subscription("trip-history"));
        await browser.page
          .locator("#latest-status")
          .filter({ hasText: "waiting for first snapshot" })
          .waitFor();
        await browser.page
          .locator("#history-status")
          .filter({ hasText: "waiting for first snapshot" })
          .waitFor();
        upstream.snapshot("live-map", { position });
        await browser.page
          .locator("#current-sequence")
          .filter({ hasText: "42" })
          .waitFor();
        assert.match(
          await browser.page.locator("#history-status").innerText(),
          /waiting for first snapshot/,
        );
        upstream.snapshot("trip-history", { positions: [] });
        await browser.page
          .locator("#history-status")
          .filter({ hasText: "empty snapshot" })
          .waitFor();
        assert.equal(await browser.page.locator("#history li").count(), 0);
        upstream.snapshot("trip-history", { positions: [position] });
        await browser.page.locator("#history li").waitFor();
        await execute(state("disconnected"));
        assert.match(
          await browser.page.locator("#position-label").innerText(),
          /Last received/i,
        );
        assert.match(
          await browser.page.locator("#latest-status").innerText(),
          /Last received.*disconnected/,
        );
        assert.match(
          await browser.page.locator("#history-status").innerText(),
          /Last received.*disconnected/,
        );
        assert.equal(await browser.page.locator("#history li").count(), 1);
        await execute(state("connected"));
        await execute(subscription("live-map"));
        await execute(subscription("trip-history"));
        assert.match(
          await browser.page.locator("#latest-status").innerText(),
          /waiting for a fresh snapshot/,
        );
        upstream.snapshot("live-map", { position });
        await browser.page
          .locator("#latest-status")
          .filter({ hasText: "Latest snapshot received" })
          .waitFor();
        assert.match(
          await browser.page.locator("#history-status").innerText(),
          /waiting for a fresh snapshot/,
        );
        upstream.snapshot("trip-history", { positions: [position] });
        await browser.page
          .locator("#history-status")
          .filter({ hasText: "1 received position" })
          .waitFor();
        await execute(subscription("live-map", "unsubscribe"));
        assert.match(
          await browser.page.locator("#latest-status").innerText(),
          /Last received.*not subscribed/,
        );
        assert.match(
          await browser.page.locator("#history-status").innerText(),
          /1 received position/,
        );
        upstream.disconnect();
        await browser.page
          .locator("#connection-status")
          .filter({ hasText: "connection failed" })
          .waitFor();
        await browser.page
          .locator("#status")
          .filter({ hasText: "run failed" })
          .waitFor();
        assert.equal(browser.signal.aborted, true);
        assert.equal(
          browser.page.isClosed(),
          false,
          "Keep the failed page available for inspection.",
        );
        await assert.rejects(execute(state("connected")));
        assert.match(
          await browser.page.locator("#history-status").innerText(),
          /Last received.*connection failed/,
        );
        await browser.page.screenshot({
          path: "/tmp/zooglass-connection-failed.png",
          fullPage: true,
        });
      } finally {
        await browser.close();
      }
    } finally {
      await upstream.close();
    }
  },
);

test(
  "a failed connection is visible even before any snapshot exists",
  { timeout: 30_000 },
  async () => {
    const upstream = await peer(true);
    try {
      const browser = await startBrowserSession(upstream.url, {
        signal: signal(),
        headless: true,
        keepOpenOnFailure: true,
      });
      try {
        await assert.rejects(
          browser.host.executor.execute(state("connected"), signal()),
        );
        await browser.page
          .locator("#connection-status")
          .filter({ hasText: "Could not connect" })
          .waitFor();
        assert.match(
          await browser.page.locator("#latest-status").innerText(),
          /No snapshot received.*connection failed/,
        );
        assert.match(
          await browser.page.locator("#history-status").innerText(),
          /No snapshot received.*connection failed/,
        );
      } finally {
        await browser.close();
      }
    } finally {
      await upstream.close();
    }
  },
);
