import assert from "node:assert/strict";
import test from "node:test";
import { chromium, type Route } from "playwright";
import { startBrowserHost } from "../../src/browser/browser-host.js";
import { vehicleBrowserApplication } from "../../src/demos/vehicle/vehicle-browser.js";
import { interactiveMapConfiguration } from "../../src/demos/vehicle/fleet-assets.js";

test(
  "provider tiles carry an origin referrer and cannot delay app registration",
  { timeout: 30_000 },
  async () => {
    const host = await startBrowserHost("http://127.0.0.1:1", {
      application: await vehicleBrowserApplication(
        true,
        interactiveMapConfiguration({}),
      ),
    });
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    try {
      browser = await chromium.launch({ headless: true });
      const context = await browser.newContext();
      const held: Route[] = [];
      let releaseTiles = false;
      const fulfill = (route: Route) =>
        route.fulfill({
          contentType: "image/svg+xml",
          body: '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#e6ebe1"/></svg>',
        });
      const unexpected: string[] = [];
      // Intercept before navigation: no provider request can reach the network.
      await context.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (url.origin === host.origin) return route.continue();
        if (url.origin === "https://tile.openstreetmap.org") {
          held.push(route);
          if (releaseTiles) await fulfill(route);
          return;
        }
        unexpected.push(url.origin);
        await route.abort();
      });
      const page = await context.newPage();
      await page.goto(host.pageUrl, { waitUntil: "domcontentloaded" });
      await host.waitForReady(AbortSignal.timeout(15_000));
      await page.waitForFunction(
        () => document.querySelectorAll(".leaflet-tile").length > 0,
      );
      assert.match(
        await page.locator("#status").innerText(),
        /Connected to Workbench/,
      );
      assert.equal(
        await page.locator("#map-background-status").getAttribute("data-state"),
        "loading",
      );
      assert.equal(await page.locator(".vehicle-map-marker").count(), 0);
      assert.equal(new URL(page.url()).hash, "");
      assert.ok(held.length > 0);
      const pending = [...held];
      releaseTiles = true;
      await Promise.all(pending.map(fulfill));
      await page.waitForFunction(
        () =>
          document.getElementById("map-background-status")?.dataset.state ===
          "available",
      );
      for (const route of held) {
        const headers = await route.request().allHeaders();
        assert.equal(
          headers.referer,
          `${host.origin}/`,
          "tile provider must receive only the origin, never registration details",
        );
        assert.ok(headers["user-agent"]);
        assert.match(
          new URL(route.request().url()).pathname,
          /^\/\d+\/\d+\/\d+\.png$/,
        );
      }
      const attribution = page.locator("#map-attribution");
      assert.match(
        await attribution.innerText(),
        /© OpenStreetMap contributors/,
      );
      assert.equal(
        await attribution
          .getByRole("link", { name: "© OpenStreetMap contributors" })
          .getAttribute("href"),
        "https://www.openstreetmap.org/copyright",
      );
      assert.deepEqual(unexpected, []);
    } finally {
      try {
        await browser?.close();
      } finally {
        await host.close();
      }
    }
  },
);
