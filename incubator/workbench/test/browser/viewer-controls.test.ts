import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createVehicleDemo } from "../../src/demos/vehicle/vehicle-demo.js";
import { loadScenario } from "../../src/scenario/scenario.js";

test(
  "manual viewer controls retain data, leave the source live and mark exploration until reset",
  { timeout: 90_000 },
  async () => {
    const scenario = await loadScenario(
      fileURLToPath(
        new URL("../../scenarios/vehicle-browser-basic.json", import.meta.url),
      ),
    );
    const demo = createVehicleDemo(scenario, { headless: true });

    const wait = async (check: () => boolean) => {
      const deadline = Date.now() + 30000;
      while (!check()) {
        assert.ok(Date.now() < deadline, JSON.stringify(demo.state));
        await delay(20);
      }
    };

    try {
      await demo.reset();
      await demo.step();

      const page = demo.browser!.page;

      await page.locator("#disconnect").click();
      await wait(() => demo.state.phase === "ready" && demo.state.exploratory);

      assert.equal(demo.state.completed, 1);
      assert.match(
        await page.locator("#latest-status").innerText(),
        /Last received/i,
      );
      assert.match(
        await page.locator("#history-status").innerText(),
        /Last received/i,
      );
      await demo.disconnect(); // Already closed is safe.
      await demo.step();

      assert.equal(await page.locator("#current-sequence").innerText(), "40");
      assert.equal(
        (await (await fetch(demo.baseUrl + "/views/live-map/car-17")).json())
          .data.position.sequence,
        42,
      );
      await page.locator("#reconnect").click();
      await wait(
        () => demo.state.phase === "complete" && demo.state.interventions === 3,
      );
      await page.waitForFunction(
        () => document.querySelector("#current-sequence")!.textContent === "42",
      );
      await page.waitForFunction(
        () => document.querySelectorAll("#history li").length === 2,
      );

      assert.equal(await page.locator("#history li").count(), 2);
      assert.match(await page.locator("#run-mode").innerText(), /Exploratory/);
      assert.doesNotMatch(
        await page.locator("#run-progress").innerText(),
        /All steps checked/,
      );
      await page.setViewportSize({ width: 390, height: 844 });

      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
      );
      await page.screenshot({
        path: "/tmp/zooglass-viewer-controls.png",
        fullPage: true,
      });
      await demo.reset();

      assert.equal(demo.state.exploratory, false);
      await demo.step();
      await demo.step();

      assert.match(demo.state.detail, /All steps checked/);
    } finally {
      await demo.close();
    }
  },
);

test(
  "scripted recovery checks duplicate history after processing and fresh snapshots on reconnect",
  { timeout: 90_000 },
  async () => {
    const scenario = await loadScenario(
      fileURLToPath(
        new URL(
          "../../scenarios/vehicle-browser-recovery.json",
          import.meta.url,
        ),
      ),
    );
    const demo = createVehicleDemo(scenario, { headless: true });

    try {
      await demo.reset();
      // 40, 42, late 41, duplicate 41, then the same-source processing barrier.
      for (let i = 0; i < 5; i++) await demo.step();

      // The barrier has been observed by the scenario's HTTP check. An old
      // browser snapshot alone would not prove the duplicate was processed.
      const response = await fetch(demo.baseUrl + "/views/trip-history/car-17");
      assert.equal(response.status, 200);
      assert.deepEqual((await response.json()).data.positions, [
        { sequence: 40, latitude: 51, longitude: -0.3 },
        { sequence: 41, latitude: 51.06, longitude: -0.29 },
        { sequence: 42, latitude: 51.1, longitude: -0.25 },
      ]);
      assert.deepEqual(
        await demo.browser!.page.locator("#history li").allTextContents(),
        [
          "Position 40 · 51.000, -0.300",
          "Position 41 · 51.060, -0.290",
          "Position 42 · 51.100, -0.250",
        ],
      );
      await demo.step(); // disconnect only after checking duplicate suppression

      assert.match(
        await demo.browser!.page.locator("#connection-status").innerText(),
        /disconnected/i,
      );
      await demo.step(); // source continues with 43; viewer remains disconnected

      assert.equal(
        await demo.browser!.page.locator("#current-sequence").innerText(),
        "42",
      );
      await demo.step(); // reconnect/subscriptions and independent receipt/render checks

      assert.equal(demo.state.phase, "complete");
      assert.equal(demo.state.exploratory, false);
      assert.equal(
        await demo.browser!.page.locator("#current-sequence").innerText(),
        "43",
      );
      assert.equal(await demo.browser!.page.locator("#history li").count(), 4);
    } finally {
      await demo.close();
    }
  },
);
