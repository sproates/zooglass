import { resetThroughBrowser } from "./support/reset.js";
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createVehicleDemo } from "../../src/demos/vehicle/vehicle-demo.js";
import { loadScenario } from "../../src/scenario/scenario.js";

test(
  "browser Step and Reset await actual receipts and replace the service, page and run",
  { timeout: 90_000 },
  async () => {
    const scenario = await loadScenario(
      fileURLToPath(
        new URL("../../scenarios/vehicle-browser-basic.json", import.meta.url),
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

      const old = demo.browser!;
      const oldBase = demo.baseUrl!;

      assert.equal(await old.page.locator("#history li").count(), 0);
      assert.match(
        await old.page.locator("#latest-status").innerText(),
        /waiting for first snapshot/,
      );
      await old.page.locator("#step").click();
      await wait(() => demo.state.completed === 1);

      assert.equal(
        await old.page.locator("#current-sequence").textContent(),
        "40",
      );
      await old.page.locator("#step").click();
      await wait(() => demo.state.phase === "complete");

      assert.equal(
        await old.page.locator("#current-sequence").textContent(),
        "42",
      );
      await resetThroughBrowser(demo, () => old.page.locator("#reset").click());

      const fresh = demo.browser!;

      assert.ok(old.page.isClosed());
      assert.notEqual(fresh.host.runId, old.host.runId);
      await assert.rejects(fetch(old.host.origin));
      await assert.rejects(fetch(oldBase + "/actuator/health"));
      assert.equal(
        (await fetch(demo.baseUrl + "/views/live-map/car-17")).status,
        404,
      );
      assert.equal(
        await fresh.page.locator("#current-sequence").textContent(),
        "—",
      );
      assert.equal(await fresh.page.locator("#history li").count(), 0);
      await fresh.page.locator("#step").click();
      await wait(() => demo.state.completed === 1);
      await fresh.page.locator("#step").click();
      await wait(() => demo.state.phase === "complete");

      assert.equal(await fresh.page.locator("#history li").count(), 2);
      await fresh.page.setViewportSize({ width: 390, height: 844 });
      await fresh.page.screenshot({
        path: "/tmp/zooglass-step-reset-mobile.png",
        fullPage: true,
      });
      // Closing the page fails the run; host-side reset remains available.
      await fresh.page.close();
      await wait(() => demo.state.phase === "failed");
      await demo.reset();

      assert.equal(demo.state.phase, "ready");
      assert.equal(await demo.browser!.page.locator("#history li").count(), 0);
    } finally {
      await demo.close();
    }
  },
);

test(
  "reset cancels a pending real-service check and returns to empty state",
  { timeout: 90_000 },
  async () => {
    const scenario = await loadScenario(
      fileURLToPath(
        new URL("../../scenarios/vehicle-browser-basic.json", import.meta.url),
      ),
    );
    const check = scenario.timeline.find(
      (entry) => entry.kind === "view-check",
    );

    assert.ok(check && check.kind === "view-check");
    // Force a pending HTTP check, without supplying fabricated data to the app.
    check.expected = { position: { sequence: -1 } };

    const demo = createVehicleDemo(scenario, { headless: true });

    try {
      await demo.reset();

      const old = demo.browser!;
      const step = demo.step();
      const rejected = assert.rejects(step);

      await old.page.waitForFunction(
        () => document.querySelector("#current-sequence")!.textContent === "40",
        undefined,
        { timeout: 5000 },
      );

      assert.equal(demo.state.phase, "stepping");
      await demo.reset();
      await rejected;

      assert.ok(old.page.isClosed());
      assert.equal(demo.state.phase, "ready");
      assert.equal(demo.state.completed, 0);
      assert.equal(await demo.browser!.page.locator("#history li").count(), 0);
    } finally {
      await demo.close();
    }
  },
);

test(
  "browser Play/Pause share Step's cursor and Reset cancels playback",
  { timeout: 90_000 },
  async () => {
    const scenario = await loadScenario(
      fileURLToPath(
        new URL("../../scenarios/vehicle-browser-basic.json", import.meta.url),
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

      await page.locator("#play").click();
      await wait(() => demo.state.playing);
      await page.waitForFunction(
        () => (document.querySelector("#step") as HTMLButtonElement).disabled,
      );
      await page.locator("#pause").click();
      await wait(
        () => !demo.state.playing && demo.state.detail.startsWith("Paused."),
      );

      const completed = demo.state.completed;

      await delay(1100);

      assert.equal(demo.state.completed, completed);
      await page.locator("#step").click();
      await wait(() => demo.state.completed === completed + 1);

      if (demo.state.phase !== "complete") {
        await page.locator("#play").click();
        await wait(() => demo.state.phase === "complete");
      }

      assert.equal(await page.locator("#current-sequence").textContent(), "42");
      await page.setViewportSize({ width: 320, height: 844 });

      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
      );
      await page.screenshot({
        path: "/tmp/zooglass-play-controls.png",
        fullPage: true,
      });
      await demo.reset();
      await demo.browser!.page.locator("#play").click();
      await wait(() => demo.state.playing);

      const old = demo.browser!;

      await resetThroughBrowser(demo, () => old.page.locator("#reset").click());
      await delay(1100);

      assert.equal(demo.state.completed, 0);
      assert.equal(demo.state.playing, false);
      assert.equal(await demo.browser!.page.locator("#history li").count(), 0);
    } finally {
      await demo.close();
    }
  },
);
