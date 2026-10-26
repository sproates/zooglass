import { resetThroughBrowser } from "../browser/support/reset.js";
import { mkdir, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createVehicleDemo } from "../../src/vehicle/vehicle-demo.js";
import { loadScenario } from "../../src/scenario.js";

test(
  "five complete browser runs release old hosts and services before fresh state is used",
  { timeout: 120_000 },
  async () => {
    const scenario = await loadScenario(
      fileURLToPath(
        new URL("../../scenarios/vehicle-browser-basic.json", import.meta.url),
      ),
    );
    const demo = createVehicleDemo(scenario, { headless: true });
    let previous:
      | { browser: NonNullable<typeof demo.browser>; baseUrl: string }
      | undefined;

    const refused = (url: string) =>
      assert.rejects(fetch(url, { signal: AbortSignal.timeout(1000) }));

    try {
      for (let cycle = 0; cycle < 5; cycle++) {
        if (!previous) await demo.reset();
        else {
          const page = previous.browser.page;
          await page.locator("#reset").focus();
          await resetThroughBrowser(demo, () =>
            cycle % 2 === 0
              ? page.keyboard.press("Space")
              : page.locator("#reset").click(),
          );
        }

        if (previous) {
          assert.equal(previous.browser.page.isClosed(), true);
          assert.equal(
            previous.browser.page.context().browser()!.isConnected(),
            false,
          );
          await refused(previous.browser.host.origin);
          await refused(previous.baseUrl + "/actuator/health");
        }

        previous = { browser: demo.browser!, baseUrl: demo.baseUrl! };

        assert.equal(demo.state.completed, 0);
        assert.equal(
          (
            await fetch(demo.baseUrl + "/views/live-map/car-17", {
              signal: AbortSignal.timeout(5000),
            })
          ).status,
          404,
        );
        await demo.step();
        await demo.step();

        assert.equal(demo.state.phase, "complete");
        assert.equal(
          await demo.browser!.page.locator("#history li").count(),
          2,
        );
      }
    } catch (error) {
      await mkdir("test-results", { recursive: true });
      await Promise.allSettled([
        writeFile(
          "test-results/reset-state.json",
          JSON.stringify(demo.state, null, 2),
        ),
        demo.browser?.page.screenshot({
          path: "test-results/reset-failure.png",
        }),
      ]);
      throw error;
    } finally {
      await demo.close();
    }

    assert.equal(previous!.browser.page.isClosed(), true);
    assert.equal(
      previous!.browser.page.context().browser()!.isConnected(),
      false,
    );
    await refused(previous!.browser.host.origin);
    await refused(previous!.baseUrl + "/actuator/health");
  },
);
