import assert from "node:assert/strict";
import test from "node:test";
import { chromium, webkit } from "playwright";
import { startSimulation } from "../../src/demos/vehicle/continuous/simulation.js";

for (const engine of [chromium, webkit]) {
  test(
    `${engine.name()}: six cars move without controls and late viewers receive snapshots`,
    { timeout: 30_000 },
    async () => {
      const simulation = await startSimulation({ tickMs: 100 });
      const browser = await engine.launch();
      try {
        const page = await browser.newPage({
          viewport: { width: 390, height: 744 },
        });
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
        await page.getByRole("button", { name: "Show all cars" }).click();
        await page.waitForTimeout(300); // Leaflet's fit animation.
        for (const marker of await page.locator(".car").all()) {
          const box = (await marker.boundingBox())!;
          assert.ok(box.x >= map.x && box.x + box.width <= map.x + map.width);
          assert.ok(box.y >= map.y && box.y + box.height <= map.y + map.height);
        }
        await page
          .getByRole("button", { name: "Inspect Car 2", exact: true })
          .click();
        assert.match(await page.locator("#selection").innerText(), /Car 2/);
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
