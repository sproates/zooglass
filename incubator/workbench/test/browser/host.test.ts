import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { startZooGlassSession } from "../../src/zooglass-session.js";
import { startBrowserSession } from "../../src/browser-session.js";
import { loadScenario } from "../../src/scenario.js";

const fixture = fileURLToPath(
  new URL("../../scenarios/vehicle-browser-basic.json", import.meta.url),
);

test(
  "owned Chromium registers, receives real ZooGlass data through the proxy and cleans up",
  { timeout: 90_000 },
  async () => {
    const scenario = await loadScenario(fixture);
    const service = await startZooGlassSession({ views: scenario.views });
    try {
      const browser = await startBrowserSession(service.baseUrl, {
        signal: service.signal,
        headless: true,
      });
      const origin = browser.host.origin;
      try {
        assert.equal(new URL(browser.page.url()).hash, "");
        assert.match(
          await browser.page.locator("#status").innerText(),
          /Connected to Workbench/,
        );
        // These transport probes are not the future scenario executor or vehicle UI.
        await browser.page.evaluate(`new Promise((resolve, reject) => {
        window.receipts = [];
        window.dataSocket = new WebSocket('ws://' + location.host + document.body.dataset.dataPath);
        dataSocket.onerror = reject;
        dataSocket.onopen = () => dataSocket.send(JSON.stringify({ action: 'subscribe', viewId: 'live-map', entityId: 'car-17' }));
        dataSocket.onmessage = event => {
          const message = JSON.parse(event.data);
          receipts.push(message);
          if (message.type === 'subscribed') resolve();
        };
      })`);
        const source = new WebSocket(
          service.baseUrl.replace("http:", "ws:") + "/events",
        );
        try {
          await once(source, "open");
          const event = scenario.timeline.find(
            (entry) => entry.kind === "source-event",
          );
          assert.ok(event && event.kind === "source-event");
          source.send(
            JSON.stringify({
              sourceId: event.sourceId,
              type: event.type,
              entityId: event.entityId,
              payload: event.payload,
            }),
          );
          await browser.page.waitForFunction(
            () =>
              (
                globalThis as unknown as { receipts: { type: string }[] }
              ).receipts.some((message) => message.type === "view-update"),
            undefined,
            { timeout: 5_000 },
          );
          const data = await browser.page.evaluate(
            "receipts.find(message => message.type === 'view-update').data",
          );
          assert.deepEqual(data, { position: event.payload });
        } finally {
          source.terminate();
        }
        // Closing data must leave the independent control connection healthy.
        await browser.page.evaluate(
          "new Promise(resolve => { dataSocket.onclose = resolve; dataSocket.close(); })",
        );
        assert.equal(browser.signal.aborted, false);
        const oldRoute = await browser.page
          .locator("body")
          .getAttribute("data-data-path");
        assert.ok(oldRoute);
        // Browser exit must fail the owned session, not leave a seemingly live host.
        const aborted = once(browser.signal, "abort");
        await browser.page.close();
        await aborted;
        assert.equal(browser.signal.aborted, true);
      } finally {
        await browser.close();
        await browser.close();
      }
      await assert.rejects(fetch(origin));
      // A subsequent launch gets a new run and context, without stale registrations.
      const next = await startBrowserSession(service.baseUrl, {
        signal: service.signal,
        headless: true,
      });
      try {
        assert.notEqual(next.host.runId, browser.host.runId);
      } finally {
        await next.close();
      }
    } finally {
      await service.close();
    }
  },
);

test(
  "cancelled browser startup rejects and cleans up",
  { timeout: 30_000 },
  async () => {
    const controller = new AbortController();
    controller.abort(new Error("Cancelled before launch"));
    await assert.rejects(
      startBrowserSession("http://127.0.0.1:1", {
        signal: controller.signal,
        headless: true,
      }),
      /Cancelled before launch/,
    );
  },
);

for (const automatic of [false, true]) {
  test(
    `demo command ${automatic ? "automatic" : "interactive"} stops its service and host on SIGTERM`,
    { timeout: 90_000 },
    async () => {
      const child = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          "src/demo.ts",
          "vehicle-tracker",
          "--headless",
          ...(automatic ? ["--auto"] : []),
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let output = "";
      const exited = once(child, "close");
      const ready = new Promise<string>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Demo startup timed out: " + output)),
          60_000,
        );
        child.once("error", reject);
        child.once("close", () => {
          clearTimeout(timer);
          reject(new Error("Demo exited before readiness: " + output));
        });
        child.stdout.on("data", (chunk) => {
          output += chunk.toString();
          const match = output.match(
            /Browser host ready at (http:\/\/127\.0\.0\.1:\d+)/,
          );
          if (match) {
            clearTimeout(timer);
            resolve(match[1]);
          }
        });
        child.stderr.on("data", (chunk) => {
          output += chunk.toString();
        });
      });
      try {
        const origin = await ready;
        child.kill("SIGTERM");
        const [code] = await exited;
        assert.equal(code, 0, output);
        await assert.rejects(fetch(origin));
        const port = output.match(/Tomcat started on port (\d+)/)?.[1];
        assert.ok(port, output);
        await assert.rejects(fetch(`http://127.0.0.1:${port}/actuator/health`));
      } finally {
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGTERM");
        await exited;
      }
    },
  );
}
