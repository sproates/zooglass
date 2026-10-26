import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadScenario } from "../../src/scenario/scenario.js";
import { createVehicleDemo } from "../../src/demos/vehicle/vehicle-demo.js";
import { resetThroughBrowser } from "./support/reset.js";

const scenario = await loadScenario(
  fileURLToPath(
    new URL("../../scenarios/vehicle-browser-recovery.json", import.meta.url),
  ),
);

test(
  "activity distinguishes sends, receipts and connections through recovery and reset",
  { timeout: 90_000 },
  async () => {
    const demo = createVehicleDemo(scenario, { headless: true });

    try {
      await demo.reset();
      const page = demo.browser!.page;
      await page
        .locator("#next-step")
        .filter({ hasText: "Send position 40" })
        .waitFor();
      await demo.step();
      await demo.step();
      await page
        .locator("#next-step")
        .filter({ hasText: "Send late position 41" })
        .waitFor();
      await demo.step();
      await page
        .locator("#next-step")
        .filter({ hasText: "Send duplicate position 41" })
        .waitFor();
      await page
        .locator("#activity li")
        .filter({ hasText: "trip-history: 3 received positions" })
        .waitFor();

      const trace = await page.locator("#activity").innerText();
      assert.match(trace, /Source sent: .*position 41/);
      assert.match(trace, /Processing is not confirmed/);
      assert.match(trace, /View received: live-map: position 42/);
      assert.match(trace, /Connection: opened \(connection 1\)/);

      while (demo.state.phase === "ready") await demo.step();
      await page
        .locator("#next-step")
        .filter({ hasText: "No further scripted steps" })
        .waitFor();
      await page
        .locator("#activity li")
        .filter({ hasText: "Connection: opened (connection 2)" })
        .waitFor();
      assert.match(
        await page.locator("#activity").innerText(),
        /Connection: closed \(connection 1\)/,
      );
      assert.match(
        await page.locator("#activity").innerText(),
        /live-map: position 43 \(connection 2\)/,
      );

      await resetThroughBrowser(demo, () => page.locator("#reset").click());
      const fresh = demo.browser!.page;
      await fresh
        .locator("#next-step")
        .filter({ hasText: "Send position 40" })
        .waitFor();
      assert.doesNotMatch(
        await fresh.locator("#activity").innerText(),
        /Source sent|position 43|connection 2/,
      );
    } finally {
      await demo.close();
    }
  },
);

test(
  "activity renderer retains only 100 entries and treats labels as text",
  { timeout: 60_000 },
  async () => {
    const demo = createVehicleDemo(scenario, { headless: true });

    try {
      await demo.reset();
      const page = demo.browser!.page;
      // Exercise only the diagnostic renderer here; these are not service receipts.
      await page.evaluate(`(async () => {
        const {recordSourceSend} = await import('/activity.js');
        for (let sequence = 0; sequence < 105; sequence++)
          recordSourceSend({sourceName: '<img src=x onerror=alert(1)>', sequence, simulationTime: 0});
      })()`);

      assert.equal(await page.locator("#activity li").count(), 100);
      assert.match(
        await page.locator("#activity li").first().innerText(),
        /position 5 /,
      );
      assert.match(
        await page.locator("#activity li").last().innerText(),
        /position 104 /,
      );
      assert.equal(await page.locator("#activity img").count(), 0);
      await page.setViewportSize({ width: 320, height: 844 });
      assert.equal(
        await page.evaluate(
          "document.documentElement.scrollWidth <= innerWidth",
        ),
        true,
      );
      await page.locator("#activity").focus();
      await page.keyboard.press("End");
      await page.waitForFunction(
        () => document.getElementById("activity")!.scrollTop > 0,
      );
      await page.screenshot({
        path: "test-results/activity-narrow.png",
        fullPage: true,
      });
    } finally {
      await demo.close();
    }
  },
);
