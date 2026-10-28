import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadScenario } from "../../src/scenario/scenario.js";
import { createVehicleDemo } from "../../src/demos/vehicle/vehicle-demo.js";

const path = fileURLToPath(
  new URL(
    "../../scenarios/browser/vehicle-connection-loss.json",
    import.meta.url,
  ),
);

test(
  "real source progresses through a refused retry and the browser recovers first snapshots automatically",
  { timeout: 90_000 },
  async () => {
    const demo = createVehicleDemo(await loadScenario(path), {
      headless: true,
    });
    try {
      await demo.reset();
      for (let step = 0; step < 6; step++) await demo.step();
      const page = demo.browser!.page;
      assert.match(await page.locator("#activity").innerText(), /retry-failed/);
      assert.match(
        await page.locator("#connection-status").innerText(),
        /reconnecting/,
      );
      assert.equal(await page.locator("#current-sequence").innerText(), "42");
      await demo.step(); // 43 reaches both server views with the data gate still closed.
      assert.equal(
        (await (await fetch(demo.baseUrl + "/views/live-map/car-17")).json())
          .data.position.sequence,
        43,
      );
      assert.deepEqual(
        (
          await (
            await fetch(demo.baseUrl + "/views/trip-history/car-17")
          ).json()
        ).data.positions.map((p: { sequence: number }) => p.sequence),
        [40, 41, 42, 43],
      );
      assert.equal(await page.locator("#current-sequence").innerText(), "42");
      await demo.step(); // Restore only. No reconnect or subscribe command is issued.
      assert.equal(demo.state.phase, "complete");
      assert.equal(demo.state.exploratory, false);
      assert.equal(await page.locator("#current-sequence").innerText(), "43");
      assert.equal(await page.locator("#history li").count(), 4);
      await page
        .locator("#activity li")
        .filter({ hasText: "Recovery: recovered" })
        .waitFor();
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
      );
    } finally {
      await demo.close();
    }
  },
);

test(
  "reset during a real fault cancels recovery and stale restore cannot affect the new run",
  { timeout: 90_000 },
  async () => {
    const demo = createVehicleDemo(await loadScenario(path), {
      headless: true,
    });
    try {
      await demo.reset();
      for (let step = 0; step < 6; step++) await demo.step();
      const old = demo.browser!;
      await demo.reset();
      assert.equal(old.page.isClosed(), true);
      await assert.rejects(
        old.host.controlDataConnection({
          runId: old.host.runId,
          clientId: old.host.clientId,
          action: "restore",
        }),
        /active run/,
      );
      await assert.rejects(
        demo.browser!.host.controlDataConnection({
          runId: old.host.runId,
          clientId: old.host.clientId,
          action: "restore",
        }),
        /active run/,
      );
      assert.equal(await demo.browser!.page.locator("#history li").count(), 0);
      await demo.step();
      assert.equal(
        await demo.browser!.page.locator("#current-sequence").innerText(),
        "40",
      );
      // Manual fault controls share the controller and explicitly mark exploration.
      const page = demo.browser!.page;
      await page
        .getByRole("button", { name: "Interrupt data", exact: true })
        .click();
      await page
        .locator("#run-mode")
        .filter({ hasText: "1 manual intervention(s)" })
        .waitFor();
      await page
        .getByRole("button", { name: "Restore data", exact: true })
        .click();
      await page
        .locator("#run-mode")
        .filter({ hasText: "2 manual intervention(s)" })
        .waitFor();
      assert.equal(demo.state.exploratory, true);
      assert.equal(demo.state.completed, 1);
      assert.equal(demo.state.interventions, 2);
    } finally {
      await demo.close();
    }
  },
);

test(
  "a real fault times out while paused and reset restores a usable run",
  { timeout: 90_000 },
  async () => {
    const scenario = await loadScenario(path);
    const fault = scenario.timeline.find(
      (entry) =>
        entry.kind === "data-connection-fault" && entry.action === "break",
    );
    assert.ok(fault?.kind === "data-connection-fault");
    fault.timeoutMs = 3000;
    const demo = createVehicleDemo(scenario, { headless: true });
    try {
      await demo.reset();
      for (let step = 0; step < 6; step++) await demo.step();
      assert.equal(demo.state.playing, false);
      await demo
        .browser!.page.locator("#connection-status")
        .filter({ hasText: "Recovery timed out" })
        .waitFor();
      await demo
        .browser!.page.locator("#run-progress")
        .filter({ hasText: /failed/i })
        .waitFor();
      assert.equal(demo.state.phase, "failed");
      await demo.reset();
      await demo.step();
      assert.equal(demo.state.completed, 1);
    } finally {
      await demo.close();
    }
  },
);
