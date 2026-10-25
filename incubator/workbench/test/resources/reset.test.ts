import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createVehicleDemo } from "../../src/vehicle-demo.js";
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
        await demo.reset();
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
