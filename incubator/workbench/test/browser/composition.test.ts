import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { WebSocketServer } from "ws";
import { startBrowserSession } from "../../src/browser/browser-session.js";
import { openScenarioSession } from "../../src/execution/scenario-session.js";
import { playScenario } from "../../src/scenario/playback.js";
import type { Scenario } from "../../src/scenario/scenario.js";

test(
  "a non-vehicle page registers and supplies receipts through the shared host and scenario session",
  { timeout: 30_000 },
  async () => {
    const upstream = new WebSocketServer({ port: 0, host: "127.0.0.1" });

    await once(upstream, "listening");
    upstream.on("connection", (socket) =>
      socket.send(
        JSON.stringify({
          viewId: "stock",
          entityId: "warehouse",
          data: { count: 7 },
        }),
      ),
    );

    const address = upstream.address();

    assert.ok(address && typeof address !== "string");

    const lifetime = new AbortController();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    let browser: Awaited<ReturnType<typeof startBrowserSession>> | undefined;
    let session: Awaited<ReturnType<typeof openScenarioSession>> | undefined;

    try {
      browser = await startBrowserSession(baseUrl, {
        signal: lifetime.signal,
        headless: true,
        application: {
          clientId: "inventory-reader",
          assets: new Map<string, readonly [string, Buffer]>([
            [
              "/",
              [
                "text/html; charset=utf-8",
                Buffer.from(
                  '<title>Inventory fixture</title><script type="module" src="/inventory.js"></script>',
                ),
              ],
            ],
            [
              "/bridge.js",
              [
                "text/javascript; charset=utf-8",
                await readFile(
                  new URL("../../browser/bridge.js", import.meta.url),
                ),
              ],
            ],
            [
              "/inventory.js",
              [
                "text/javascript; charset=utf-8",
                await readFile(
                  new URL("../fixtures/browser/inventory.js", import.meta.url),
                ),
              ],
            ],
          ]),
        },
      });

      assert.equal(await browser.page.title(), "Inventory fixture");
      assert.equal(new URL(browser.page.url()).hash, "");
      assert.equal(
        (await fetch(browser.host.origin + "/vehicle-client.js")).status,
        404,
      );

      const scenario: Scenario = {
        name: "Inventory",
        sources: [],
        views: [],
        clients: [
          {
            id: "inventory-reader",
            name: "Inventory",
            initialState: "connected",
          },
        ],
        timeline: [
          {
            kind: "client-view-check",
            simulationTime: 0,
            clientId: "inventory-reader",
            viewId: "stock",
            entityId: "warehouse",
            expected: { count: 7 },
          },
        ],
      };

      session = await openScenarioSession(scenario, baseUrl, {
        signal: browser.signal,
        createClientExecutor: (client) => {
          assert.equal(client.id, browser!.host.clientId);
          return browser!.host.executor;
        },
      });
      for (const entry of playScenario(scenario)) await session.execute(entry);

      assert.equal(browser.signal.aborted, false);
    } finally {
      try {
        await session?.close();
      } finally {
        try {
          await browser?.close();
        } finally {
          for (const socket of upstream.clients) socket.terminate();
          await new Promise<void>((resolve) => upstream.close(() => resolve()));
        }
      }
    }

    assert.equal(browser!.page.isClosed(), true);
    await assert.rejects(fetch(browser!.host.origin));
  },
);
