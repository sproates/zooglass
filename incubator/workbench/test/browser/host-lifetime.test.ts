import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { WebSocket } from "ws";
import { startApplicationHost } from "../../src/browser/browser-host.js";
import { launchOwnedBrowser } from "../../src/browser/owned-browser.js";
import { vehicleBrowserApplication } from "../../src/demos/vehicle/vehicle-browser.js";
import { startZooGlassSession } from "../../src/service/zooglass-session.js";
import { playScenario } from "../../src/scenario/playback.js";
import { loadScenario } from "../../src/scenario/scenario.js";
import { openScenarioSession } from "../../src/execution/scenario-session.js";
import { signal } from "./support/view-peer.js";

async function refused(url: string, origin: string) {
  const socket = new WebSocket(url.replace("http:", "ws:"), { origin });
  socket.on("error", () => {});
  const status = await new Promise<number | undefined>((resolve) => {
    socket.once("unexpected-response", (_request, response) => {
      resolve(response.statusCode);
      response.destroy();
    });
  });
  socket.terminate();
  assert.equal(status, 403);
}

test(
  "a stable host rebinds the same fleet page to fresh services and retires old routes",
  { timeout: 60_000 },
  async () => {
    const scenario = await loadScenario(
      "scenarios/vehicle-fleet-contracts.json",
    );
    const host = await startApplicationHost({
      application: await vehicleBrowserApplication(true),
    });
    let service: Awaited<ReturnType<typeof startZooGlassSession>> | undefined;
    let browser: Awaited<ReturnType<typeof launchOwnedBrowser>> | undefined;
    let session: Awaited<ReturnType<typeof openScenarioSession>> | undefined;
    try {
      service = await startZooGlassSession({ views: scenario.views });
      let run = await host.replaceRun(service.baseUrl);
      browser = await launchOwnedBrowser(host.pageUrl, {
        headless: true,
        signal: host.signal,
      });
      const page = browser.page;
      await run.waitForReady(signal());
      const originalUrl = page.url();
      // A document-local sentinel detects navigation as well as page replacement.
      await page.evaluate("window.stableDocument = true");
      let newControlSockets = 0;
      page.on("websocket", (socket) => {
        if (socket.url().endsWith("/control")) newControlSockets++;
      });

      for (let iteration = 0; iteration < 3; iteration++) {
        await run.waitForReady(signal());
        assert.equal(page.url(), originalUrl);
        assert.equal(await page.evaluate("window.stableDocument"), true);
        assert.equal(await page.locator(".vehicle-map-marker").count(), 0);
        assert.equal(await page.locator("#fleet-list > li").count(), 3);
        assert.equal(await page.locator("#history li").count(), 0);
        assert.equal(await page.locator("#activity li").count(), 0);
        assert.equal(
          await page.locator("#follow-selected").getAttribute("aria-pressed"),
          "false",
        );
        assert.equal(run.observations.cursor(), 0);
        session = await openScenarioSession(scenario, service.baseUrl, {
          signal: run.signal,
          createClientExecutor: () => run.executor,
        });
        for (const entry of playScenario(scenario))
          await session.execute(entry);
        await page.waitForFunction(
          () =>
            document.querySelector("#current-sequence")?.textContent === "42",
        );
        assert.equal(await page.locator(".vehicle-map-marker").count(), 3);
        await page.locator("#follow-selected").click();
        assert.equal(
          await page.locator("#follow-selected").getAttribute("aria-pressed"),
          "true",
        );

        if (iteration === 2) break;
        const old = run;
        const oldRoute = old.dataPath;
        await session.close();
        session = undefined;
        const oldService = service;
        const probe = new WebSocket(
          (host.origin + oldRoute).replace("http:", "ws:"),
          { origin: host.origin },
        );
        probe.on("error", () => {});
        await once(probe, "open");
        const retired = once(probe, "close");
        try {
          service = await startZooGlassSession({ views: scenario.views });
          run = await host.replaceRun(service.baseUrl);
          await retired;
        } finally {
          probe.terminate();
          await oldService.close();
        }
        assert.notEqual(run.runId, old.runId);
        assert.notEqual(run.dataPath, oldRoute);
        assert.equal(old.signal.aborted, true);
        await assert.rejects(
          old.executor.execute(
            {
              kind: "client-state",
              clientId: old.clientId,
              clientName: "Fleet",
              simulationTime: 0,
              state: "connected",
            },
            signal(),
          ),
        );
        await refused(host.origin + oldRoute, host.origin);
      }
      assert.equal(
        newControlSockets,
        0,
        "run replacement keeps the original control connection",
      );
      await browser.close();
      assert.equal(
        (await fetch(host.origin)).status,
        200,
        "closing Chromium does not close its caller-owned host",
      );
    } finally {
      await session?.close();
      await browser?.close();
      await host.close();
      await service?.close();
    }
    await assert.rejects(fetch(host.origin));
  },
);

test(
  "readiness is run-scoped and bounded; stale messages cannot unlock a replacement",
  { timeout: 15_000 },
  async () => {
    let controls = 0;
    const host = await startApplicationHost({
      application: { clientId: "reader", assets: new Map() },
      onControl: async () => {
        controls++;
      },
    });
    let socket: WebSocket | undefined;
    try {
      const first = await host.replaceRun("http://127.0.0.1:1");
      const registration = Object.fromEntries(
        new URLSearchParams(new URL(host.pageUrl).hash.slice(1)),
      );
      socket = new WebSocket(host.origin.replace("http:", "ws:") + "/control", {
        origin: host.origin,
      });
      await once(socket, "open");
      const registered = once(socket, "message");
      socket.send(
        JSON.stringify({
          ...registration,
          type: "register",
          protocolVersion: 1,
        }),
      );
      await registered;
      socket.send(JSON.stringify({ ...registration, type: "ready" }));
      await first.waitForReady(signal());
      const changed = once(socket, "message");
      const next = await host.replaceRun("http://127.0.0.1:1");
      await changed;
      await refused(host.origin + next.dataPath, host.origin);
      for (const message of [
        { type: "ready" },
        { type: "control-request", action: "step" },
        { type: "fatal", reason: "old failure" },
        {
          type: "observation",
          event: "opened",
          connectionGeneration: 1,
          observationIndex: 1,
        },
      ])
        socket.send(
          JSON.stringify({
            ...message,
            runId: first.runId,
            clientId: first.clientId,
          }),
        );
      await assert.rejects(next.waitForReady(signal(), 100));
      assert.equal(next.signal.aborted, true);
      assert.equal(controls, 0);
      assert.equal(next.observations.cursor(), 0);
      assert.equal(host.signal.aborted, false);
    } finally {
      socket?.terminate();
      await host.close();
    }
  },
);
