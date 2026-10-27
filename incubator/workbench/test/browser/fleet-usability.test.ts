import assert from "node:assert/strict";
import test from "node:test";
import { mkdir } from "node:fs/promises";
import { loadScenario } from "../../src/scenario/scenario.js";
import { createVehicleDemo } from "../../src/demos/vehicle/vehicle-demo.js";

test(
  "fleet playback preserves keyboard selection and reflows enlarged text",
  { timeout: 60_000 },
  async () => {
    const scenario = await loadScenario(
      "scenarios/vehicle-fleet-contracts.json",
    );
    // Allow keyboard interaction between actions without changing events or checks.
    for (const entry of scenario.timeline) entry.simulationTime *= 10;
    const demo = createVehicleDemo(scenario, { fleet: true, headless: true });

    try {
      await demo.reset();
      const page = demo.browser!.page;
      await page.setViewportSize({ width: 320, height: 844 });
      await page.keyboard.press("Tab");
      assert.equal(
        await page.evaluate(() => document.activeElement?.id),
        "step",
      );
      await page.keyboard.press("Tab");
      assert.equal(
        await page.evaluate(() => document.activeElement?.id),
        "play",
      );
      await page.keyboard.press("Space");
      await page.waitForFunction(
        () => !(document.getElementById("pause") as HTMLButtonElement).disabled,
      );
      await page.keyboard.press("Tab");
      assert.equal(
        await page.evaluate(() => document.activeElement?.id),
        "pause",
      );
      await page.keyboard.press("Enter");
      await page
        .locator("#run-progress")
        .filter({ hasText: "Paused." })
        .waitFor();
      assert.equal(demo.state.playing, false);

      // Enter the fleet using normal tab order, then select without a mouse.
      await page.locator("#reset").focus();
      await page.keyboard.press("Tab");
      assert.equal(
        await page.evaluate(() => document.activeElement?.textContent),
        "Vehicle 17",
      );
      await page.keyboard.press("Tab");
      await page.keyboard.press("Space");
      const selected = page.getByRole("button", {
        name: "Vehicle 28",
        exact: true,
      });
      assert.equal(await selected.getAttribute("aria-pressed"), "true");
      assert.equal(
        await page.locator("#fleet-detail").getAttribute("data-entity-id"),
        "car-28",
      );

      // Start through the browser, then leave keyboard focus on the selected row.
      await page.locator("#play").focus();
      await page.keyboard.press("Enter");
      await selected.focus();
      await page
        .locator("#run-progress")
        .filter({ hasText: "All steps checked." })
        .waitFor();
      assert.equal(demo.state.phase, "complete");
      assert.equal(demo.state.exploratory, false);
      assert.equal(
        await selected.evaluate((node) => node === document.activeElement),
        true,
      );
      assert.equal(
        await page.locator("#current-operation").textContent(),
        "available · sequence 102",
      );
      assert.equal(await page.locator("#current-sequence").textContent(), "40");
      assert.equal(await page.locator("#history li").count(), 1);

      await page.keyboard.press("Tab");
      await page.keyboard.press("Enter");
      assert.equal(
        await page.locator("#fleet-detail").getAttribute("data-entity-id"),
        "car-39",
      );
      assert.equal(await page.locator("#current-sequence").textContent(), "41");
      assert.equal(await page.locator("#history li").count(), 2);

      await mkdir("test-results", { recursive: true });
      for (const width of [1280, 390, 320]) {
        await page.setViewportSize({ width, height: 844 });
        for (const fontSize of ["100%", "200%"]) {
          await page.evaluate((size) => {
            document.documentElement.style.fontSize = size;
          }, fontSize);
          assert.equal(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth,
            ),
            true,
            `${width}px at ${fontSize} must reflow`,
          );
          assert.equal(
            await page.locator(".control-buttons").evaluate((container) => {
              const bounds = container.getBoundingClientRect();
              return [...container.querySelectorAll("button")].every(
                (button) => {
                  const rect = button.getBoundingClientRect();
                  return rect.left >= bounds.left && rect.right <= bounds.right;
                },
              );
            }),
            true,
            "controls stay inside their panel",
          );
          await page.screenshot({
            path: `test-results/fleet-${width}-${fontSize.slice(0, -1)}.png`,
            fullPage: true,
          });
        }
      }
    } finally {
      await demo.close();
    }
  },
);
