import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadScenario } from "../../src/scenario/scenario.js";
import { createVehicleDemo } from "../../src/demos/vehicle/vehicle-demo.js";

const fixture = fileURLToPath(
  new URL("../../scenarios/vehicle-fleet-contracts.json", import.meta.url),
);

test(
  "fleet selection preserves independent state, subscriptions and reset",
  { timeout: 90_000 },
  async () => {
    const scenario = await loadScenario(fixture);
    const demo = createVehicleDemo(scenario, { fleet: true, headless: true });
    try {
      await demo.reset();
      const page = demo.browser!.page;
      assert.equal(await page.locator("#fleet-list li").count(), 3);
      assert.equal(await page.locator("#current-sequence").textContent(), "—");
      assert.match(
        await page.locator("#history-status").innerText(),
        /waiting for first snapshot/,
      );

      // Record protocol sends only; never supply application values.
      await page.evaluate(() => {
        const original = WebSocket.prototype.send;
        (window as unknown as { sent: string[] }).sent = [];
        WebSocket.prototype.send = function (data) {
          if (typeof data === "string" && this.url.includes("/views/live?"))
            (window as unknown as { sent: string[] }).sent.push(data);
          return original.call(this, data);
        };
      });
      await page
        .getByRole("button", { name: "Vehicle 28", exact: true })
        .click();
      while (demo.state.phase === "ready") await demo.step();
      assert.equal(demo.state.phase, "complete");
      assert.equal(
        await page.locator("#fleet-detail").getAttribute("data-entity-id"),
        "car-28",
      );

      for (const expected of [
        {
          name: "Vehicle 17",
          sequence: "42",
          coordinates: "36.1412, -5.3532",
          operation: "available · sequence 100",
          history: ["40", "41", "42"],
        },
        {
          name: "Vehicle 28",
          sequence: "40",
          coordinates: "36.1432, -5.3544",
          operation: "available · sequence 102",
          history: ["40"],
        },
        {
          name: "Vehicle 39",
          sequence: "41",
          coordinates: "36.1389, -5.3526",
          operation: "available · sequence 101",
          history: ["40", "41"],
        },
      ]) {
        await page
          .getByRole("button", { name: expected.name, exact: true })
          .click();
        assert.equal(
          await page.locator("#current-sequence").textContent(),
          expected.sequence,
        );
        assert.equal(
          await page.locator("#current-coordinates").textContent(),
          expected.coordinates,
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
      assert.deepEqual(
        await page.evaluate(
          () => (window as unknown as { sent: string[] }).sent,
        ),
        [],
        "selection must not send subscription commands",
      );
      await page.screenshot({
        path: "/tmp/zooglass-fleet-desktop.png",
        fullPage: true,
      });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({
        path: "/tmp/zooglass-fleet-mobile.png",
        fullPage: true,
      });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
        true,
      );

      await demo.disconnect();
      assert.equal(
        await page.locator("#latest-status").getAttribute("data-state"),
        "retained",
      );
      await page
        .getByRole("button", { name: "Vehicle 17", exact: true })
        .click();
      assert.equal(await page.locator("#current-sequence").textContent(), "42");
      assert.match(
        await page.locator("#history-status").innerText(),
        /disconnected/,
      );
      await demo.reconnect();
      await page.waitForFunction(() =>
        Array.from(document.querySelectorAll(".fleet-status")).every(
          (node) => (node as HTMLElement).dataset.state === "received",
        ),
      );
      const subscriptions = await page.evaluate(() =>
        (window as unknown as { sent: string[] }).sent
          .map((text) => JSON.parse(text))
          .filter((message) => message.action === "subscribe"),
      );
      assert.equal(subscriptions.length, 6);
      assert.equal(
        new Set(
          subscriptions.map((message) =>
            JSON.stringify([message.viewId, message.entityId]),
          ),
        ).size,
        6,
      );
      assert.equal(
        await page.locator("#fleet-detail").getAttribute("data-entity-id"),
        "car-17",
      );

      await demo.reset();
      assert.equal(page.isClosed(), true);
      const fresh = demo.browser!.page;
      assert.equal(await fresh.locator("#current-sequence").textContent(), "—");
      assert.equal(await fresh.locator("#history li").count(), 0);
      assert.equal(
        await fresh.locator("#current-operation").textContent(),
        "No operational status received",
      );
    } finally {
      await demo.close();
    }
  },
);

test(
  "fleet rendered checks fail when correct receipts cannot be seen",
  { timeout: 30_000 },
  async () => {
    const demo = createVehicleDemo(await loadScenario(fixture), {
      fleet: true,
      headless: true,
    });
    try {
      await demo.reset();
      // Break presentation only. The live socket and model still receive real values.
      await demo
        .browser!.page.locator(".fleet-position")
        .first()
        .evaluate((node) => node.remove());
      await assert.rejects(async () => {
        while (demo.state.phase === "ready") await demo.step();
      }, /Timeout/);
      assert.equal(demo.state.phase, "failed");
    } finally {
      await demo.close();
    }
  },
);
