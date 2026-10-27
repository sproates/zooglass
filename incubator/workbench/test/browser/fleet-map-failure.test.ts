import assert from "node:assert/strict";
import test from "node:test";
import { mkdir } from "node:fs/promises";
import type { Route } from "playwright";
import { createVehicleDemo } from "../../src/demos/vehicle/vehicle-demo.js";
import { loadScenario } from "../../src/scenario/scenario.js";

const tile =
  '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#e6ebe1"/></svg>';

test(
  "failed and stalled tiles leave fleet playback usable; retry restores the background",
  { timeout: 60_000 },
  async () => {
    const demo = createVehicleDemo(
      await loadScenario("scenarios/vehicle-fleet-contracts.json"),
      {
        fleet: true,
        headless: true,
        map: {
          tileUrl: "/missing/{z}/{x}/{y}.svg",
          attribution: "Local failure fixture",
        },
      },
    );
    try {
      await demo.reset();
      const page = demo.browser!.page;
      const status = page.locator("#map-background-status");
      await status.filter({ hasText: "Map background unavailable" }).waitFor();
      assert.equal(demo.state.phase, "ready");
      while (demo.state.phase === "ready") await demo.step();
      assert.equal(demo.state.phase, "complete");
      assert.equal(await page.locator(".vehicle-map-marker").count(), 3);
      assert.equal(await page.locator("#current-sequence").textContent(), "42");
      assert.match(
        await page.locator("#connection-status").innerText(),
        /ZooGlass connected/,
      );
      await mkdir("test-results", { recursive: true });
      await page
        .locator(".map-panel")
        .screenshot({ path: "test-results/map-unavailable.png" });
      await page
        .getByRole("button", { name: "Vehicle 28", exact: true })
        .click();
      assert.equal(await page.locator("#history li").count(), 1);

      await page.route("**/missing/**", (route) =>
        route.fulfill({ contentType: "image/svg+xml", body: tile }),
      );
      await page.locator("#retry-map").focus();
      await page.keyboard.press("Enter");
      await page.waitForFunction(
        () =>
          document.getElementById("map-background-status")?.dataset.state ===
          "available",
      );
      assert.equal(await page.locator("#retry-map").isDisabled(), true);

      await page.clock.install();
      const stalled: Route[] = [];
      await page.route("**/missing/**", (route) => {
        stalled.push(route);
      });
      await page.locator(".leaflet-control-zoom-in").click();
      await page.waitForFunction(
        () =>
          document.getElementById("map-background-status")?.dataset.state ===
          "loading",
      );
      await page.clock.runFor(10_001);
      assert.equal(await status.getAttribute("data-state"), "unavailable");
      assert.match(
        await page.locator("#connection-status").innerText(),
        /ZooGlass connected/,
      );
      assert.equal(demo.state.phase, "complete");
      assert.ok(stalled.length > 0);
      for (const request of stalled)
        await request.fulfill({ contentType: "image/svg+xml", body: tile });
      await page.waitForFunction(
        () =>
          document.getElementById("map-background-status")?.dataset.state ===
          "available",
      );
    } finally {
      await demo.close();
    }
  },
);
