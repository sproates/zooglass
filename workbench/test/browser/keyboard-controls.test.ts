import assert from "node:assert/strict";
import test from "node:test";
import { loadScenario } from "../../src/scenario/scenario.js";
import { createVehicleDemo } from "../../src/demos/vehicle/vehicle-demo.js";

test(
  "playback, viewer and fault controls can be reached and operated by keyboard",
  { timeout: 60_000 },
  async () => {
    const scenario = await loadScenario(
      "scenarios/vehicle-browser-journey.json",
    );
    const demo = createVehicleDemo(scenario, { headless: true });

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
      await demo.step(); // Give both desired views a snapshot before recovery.

      // Resume tab navigation from the paused controls and exercise both pairs.
      await page.locator("#play").focus();
      const actions = [
        { id: "disconnect", key: "Space" },
        { id: "reconnect", key: "Enter" },
        { id: "interrupt", key: "Space" },
        { id: "restore", key: "Enter" },
      ];
      for (const [index, action] of actions.entries()) {
        await page.keyboard.press("Tab");
        assert.equal(
          await page.evaluate(() => document.activeElement?.id),
          action.id,
        );
        await page.keyboard.press(action.key);
        await page
          .locator("#run-mode")
          .filter({ hasText: `${index + 1} manual intervention(s)` })
          .waitFor();
        // Actions temporarily disable the focused button; restore the starting
        // point so the next Tab checks the intended order consistently.
        await page.waitForFunction(
          (id) => !(document.getElementById(id) as HTMLButtonElement).disabled,
          action.id,
        );
        await page.locator(`#${action.id}`).focus();
      }
      assert.equal(demo.state.exploratory, true);
      assert.equal(demo.state.interventions, 4);
      await page.keyboard.press("Tab");
      assert.equal(
        await page.evaluate(() => document.activeElement?.id),
        "reset",
      );
    } finally {
      await demo.close();
    }
  },
);
