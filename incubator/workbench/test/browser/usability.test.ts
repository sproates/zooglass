import { resetThroughBrowser } from "./support/reset.js";
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { createVehicleDemo } from "../../src/demos/vehicle/vehicle-demo.js";
import { loadScenario } from "../../src/scenario/scenario.js";

test(
  "keyboard controls and scrollable history work at narrow widths",
  { timeout: 90_000 },
  async () => {
    const scenario = await loadScenario(
      fileURLToPath(
        new URL(
          "../../scenarios/vehicle-browser-journey.json",
          import.meta.url,
        ),
      ),
    );
    const demo = createVehicleDemo(scenario, { headless: true });

    const wait = async (condition: () => boolean) => {
      const deadline = Date.now() + 30_000;
      while (!condition()) {
        assert.ok(Date.now() < deadline, JSON.stringify(demo.state));
        await delay(20);
      }
    };

    try {
      await demo.reset();

      const page = demo.browser!.page;

      await page.setViewportSize({ width: 390, height: 844 });
      await page.keyboard.press("Tab");

      assert.equal(await page.evaluate("document.activeElement.id"), "step");
      await mkdir("test-results", { recursive: true });
      await page.screenshot({
        path: "test-results/keyboard-ready.png",
        fullPage: true,
      });
      await page.keyboard.press("Enter");
      await wait(() => demo.state.completed === 1);
      while (demo.state.phase === "ready") await demo.step();

      assert.equal(demo.state.phase, "complete");
      // Disabled Step leaves Reset and the scrollable history in the tab order.
      await page.locator("#reset").focus();
      await page.keyboard.press("Tab");

      assert.equal(await page.evaluate("document.activeElement.id"), "history");
      await page.keyboard.press("End");
      await page.waitForFunction(
        () => document.getElementById("history")!.scrollTop > 0,
      );
      for (const width of [390, 320, 1280]) {
        await page.setViewportSize({ width, height: 844 });

        assert.equal(
          await page.evaluate(
            "document.documentElement.scrollWidth <= innerWidth",
          ),
          true,
          `overflow at ${width}px`,
        );
        await page.screenshot({
          path: `test-results/journey-${width}.png`,
          fullPage: true,
        });
      }
      await page.keyboard.press("Shift+Tab");

      assert.equal(await page.evaluate("document.activeElement.id"), "reset");
      await resetThroughBrowser(demo, () => page.keyboard.press("Space"));

      assert.equal(await demo.browser!.page.locator("#history li").count(), 0);
      await demo.browser!.page.keyboard.press("Tab");
      await demo.browser!.page.keyboard.press("Enter");
      await wait(() => demo.state.completed === 1);
    } finally {
      await demo.close();
    }
  },
);
