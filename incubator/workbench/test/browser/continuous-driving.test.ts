import assert from "node:assert/strict";
import test from "node:test";
import { chromium, webkit } from "playwright";
import { startSimulation } from "../../src/demos/vehicle/continuous/simulation.js";

for (const engine of [chromium, webkit]) {
  test(
    `${engine.name()}: six cars move without controls and late viewers receive snapshots`,
    { timeout: 60_000 },
    async () => {
      const simulation = await startSimulation({ tickMs: 100 });
      const browser = await engine.launch();
      try {
        const page = await browser.newPage({
          viewport: { width: 390, height: 744 },
        });
        page.setDefaultTimeout(10_000);
        await page.addInitScript(`
        const NativeWebSocket = window.WebSocket;
        window.WebSocket = class extends NativeWebSocket {
          constructor(...args) { super(...args); window.testDataSocket = this; }
        };
      `);
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(simulation.origin);
        await page.waitForFunction(
          () => document.querySelectorAll(".car").length === 6,
        );
        assert.equal(
          await page
            .getByRole("button", { name: /^(Play|Pause|Reset|Step)$/ })
            .count(),
          0,
        );
        const before = await page
          .locator('.car[data-entity-id="car-1"]')
          .getAttribute("data-sequence");
        await page.waitForFunction(
          (sequence) =>
            Number(
              document
                .querySelector('.car[data-entity-id="car-1"]')
                ?.getAttribute("data-sequence"),
            ) >
            Number(sequence) + 2,
          before,
        );
        const map = (await page.locator("#map").boundingBox())!;
        assert.ok(
          map.y < 100 && map.height > 400,
          "the map occupies the initial phone screen",
        );
        const credit = (await page.locator("#map-attribution").boundingBox())!;
        assert.ok(
          credit.y + credit.height <= 744,
          "map attribution remains visible on the phone",
        );
        await page.getByRole("button", { name: "Show all cars" }).click();
        await page.waitForTimeout(300); // Leaflet's fit animation.
        for (const marker of await page.locator(".car").all()) {
          const box = (await marker.boundingBox())!;
          assert.ok(box.x >= map.x && box.x + box.width <= map.x + map.width);
          assert.ok(box.y >= map.y && box.y + box.height <= map.y + map.height);
        }
        // Markers move every 100ms in this accelerated fixture. Send a pointer
        // click without waiting for two stationary animation frames.
        await page
          .getByRole("button", { name: "Inspect Car 2", exact: true })
          .click({ force: true });
        assert.match(await page.locator("#selection").innerText(), /Car 2/);
        const beforeOffline = await page
          .locator('.car[data-entity-id="car-1"]')
          .getAttribute("data-sequence");
        await page.context().setOffline(true);
        await page.evaluate("window.testDataSocket.close()");
        // Disconnected text lasts only until the next retry. Retained markers
        // stay stale throughout the offline period, even on a busy CI runner.
        await page.waitForFunction(
          () => document.querySelectorAll(".car.stale").length === 6,
        );
        await page.context().setOffline(false);
        await page.waitForFunction(
          (sequence) =>
            Number(
              document
                .querySelector('.car[data-entity-id="car-1"]')
                ?.getAttribute("data-sequence"),
            ) > Number(sequence),
          beforeOffline,
        );
        await page.waitForFunction(
          () => document.querySelectorAll(".car:not(.stale)").length > 0,
        );

        // Observe the actual close event rather than polling transient status text.
        await page.evaluate(`new Promise(resolve => {
          window.testDataSocket.addEventListener("close", resolve, { once: true });
          window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
        })`);
        await page.evaluate(() =>
          window.dispatchEvent(
            new PageTransitionEvent("pageshow", { persisted: true }),
          ),
        );
        await page
          .locator("#connection")
          .filter({ hasText: "Receiving positions" })
          .waitFor();
        await page.waitForFunction(
          () => document.querySelectorAll(".car:not(.stale)").length > 0,
        );
        await page.close();
        const viewer = await browser.newPage();
        await viewer.goto(simulation.origin);
        await viewer.waitForFunction(
          () => document.querySelectorAll(".car").length === 6,
        );
        assert.ok(
          Number(
            await viewer
              .locator('.car[data-entity-id="car-1"]')
              .getAttribute("data-sequence"),
          ) > Number(before),
        );
        assert.deepEqual(errors, []);
      } finally {
        await browser.close();
        await simulation.close();
      }
    },
  );
}
