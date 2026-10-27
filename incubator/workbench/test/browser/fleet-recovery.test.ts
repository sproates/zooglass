import assert from "node:assert/strict";
import test from "node:test";
import { loadScenario } from "../../src/scenario/scenario.js";
import { createVehicleDemo } from "../../src/demos/vehicle/vehicle-demo.js";

test(
  "fleet reconnect catches up every pair after sources advance offline",
  { timeout: 60_000 },
  async () => {
    const demo = createVehicleDemo(
      await loadScenario("scenarios/vehicle-fleet-contracts.json"),
      { fleet: true, headless: true },
    );
    try {
      await demo.reset();
      const page = demo.browser!.page;
      while ((await page.locator("#current-sequence").textContent()) === "—") {
        assert.equal(demo.state.phase, "ready");
        await demo.step();
      }
      assert.equal(await page.locator("#current-sequence").textContent(), "40");
      await demo.disconnect();
      while (demo.state.phase === "ready") await demo.step();
      assert.equal(demo.state.phase, "complete");
      assert.equal(demo.state.exploratory, true);
      assert.equal(await page.locator("#current-sequence").textContent(), "40");
      assert.equal(await page.locator("#history li").count(), 1);
      assert.equal(
        await page.locator("#latest-status").getAttribute("data-state"),
        "retained",
      );

      await demo.reconnect();
      // No more source events: these values must come from resubscription snapshots.
      for (const expected of [
        {
          name: "Vehicle 17",
          sequence: "42",
          operation: "available · sequence 100",
          history: ["40", "41", "42"],
        },
        {
          name: "Vehicle 28",
          sequence: "40",
          operation: "available · sequence 102",
          history: ["40"],
        },
        {
          name: "Vehicle 39",
          sequence: "41",
          operation: "available · sequence 101",
          history: ["40", "41"],
        },
      ]) {
        await page
          .getByRole("button", { name: expected.name, exact: true })
          .click();
        await page.waitForFunction(() =>
          ["latest-status", "history-status"].every(
            (id) => document.getElementById(id)?.dataset.state === "received",
          ),
        );
        assert.equal(
          await page.locator("#current-sequence").textContent(),
          expected.sequence,
        );
        assert.equal(
          await page.locator("#current-operation").textContent(),
          expected.operation,
        );
        assert.deepEqual(
          await page
            .locator("#history li")
            .evaluateAll((rows) =>
              rows.map((row) => (row as HTMLElement).dataset.sequence),
            ),
          expected.history,
        );
      }
      assert.match(
        await page.locator("#run-progress").innerText(),
        /not a scripted pass/,
      );
    } finally {
      await demo.close();
    }
  },
);
