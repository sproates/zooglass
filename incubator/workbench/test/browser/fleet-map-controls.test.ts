import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright";
import { loadScenario } from "../../src/scenario/scenario.js";
import { createVehicleDemo } from "../../src/demos/vehicle/vehicle-demo.js";

async function markerOffset(page: Page, id: string) {
  const map = (await page.locator("#fleet-map").boundingBox())!;
  const marker = (await page
    .locator(`.vehicle-map-marker[data-entity-id="${id}"]`)
    .boundingBox())!;
  return {
    x: marker.x + marker.width / 2 - map.x - map.width / 2,
    y: marker.y + marker.height / 2 - map.y - map.height / 2,
  };
}

async function assertCentred(page: Page, id: string) {
  const offset = await markerOffset(page, id);
  assert.ok(
    Math.abs(offset.x) <= 2 && Math.abs(offset.y) <= 2,
    JSON.stringify(offset),
  );
}

test(
  "fit and follow use received positions; mouse and keyboard navigation release follow",
  { timeout: 60_000 },
  async () => {
    const demo = createVehicleDemo(
      await loadScenario("scenarios/vehicle-fleet-contracts.json"),
      { fleet: true, headless: true },
    );
    try {
      await demo.reset();
      const page = demo.browser!.page;
      assert.equal(await page.locator("#fit-fleet").isDisabled(), true);
      assert.equal(await page.locator("#follow-selected").isDisabled(), true);
      while ((await page.locator("#current-sequence").textContent()) === "—")
        await demo.step();

      await page.locator("#follow-selected").focus();
      await page.keyboard.press("Space");
      assert.equal(
        await page.locator("#follow-selected").getAttribute("aria-pressed"),
        "true",
      );
      await assertCentred(page, "car-17");
      while ((await page.locator("#current-sequence").textContent()) !== "42")
        await demo.step();
      await assertCentred(page, "car-17");
      await page
        .getByRole("button", { name: "Vehicle 28", exact: true })
        .click();
      await assertCentred(page, "car-28");

      await page.locator("#fleet-map").scrollIntoViewIfNeeded();
      const box = (await page.locator("#fleet-map").boundingBox())!;
      await page.mouse.move(box.x + 90, box.y + 130);
      await page.mouse.down();
      await page.mouse.move(box.x + 180, box.y + 160, { steps: 8 });
      await page.mouse.up();
      assert.equal(
        await page.locator("#follow-selected").getAttribute("aria-pressed"),
        "false",
      );
      // Let Leaflet's inertial pan settle before comparing later source updates.
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          }),
      );
      await page.waitForFunction(
        () => !document.querySelector("#fleet-map .leaflet-pan-anim"),
      );
      const before = await markerOffset(page, "car-28");
      while (demo.state.phase === "ready") await demo.step();
      const after = await markerOffset(page, "car-28");
      assert.ok(
        Math.abs(before.x - after.x) <= 2 && Math.abs(before.y - after.y) <= 2,
        `later receipts must not undo manual navigation: ${JSON.stringify({ before, after })}`,
      );

      await page.locator("#fit-fleet").focus();
      await page.keyboard.press("Enter");
      const fitted = (await page.locator("#fleet-map").boundingBox())!;
      for (const marker of await page.locator(".vehicle-map-marker").all()) {
        const bounds = (await marker.boundingBox())!;
        assert.ok(
          bounds.x >= fitted.x &&
            bounds.x + bounds.width <= fitted.x + fitted.width,
        );
        assert.ok(
          bounds.y >= fitted.y &&
            bounds.y + bounds.height <= fitted.y + fitted.height,
        );
      }
      await page
        .getByRole("button", { name: "Select Vehicle 39 on map", exact: true })
        .focus();
      await page.keyboard.press("Enter");
      assert.equal(
        await page.locator("#fleet-detail").getAttribute("data-entity-id"),
        "car-39",
      );
      await page
        .getByRole("button", { name: "Select Vehicle 28 on map", exact: true })
        .focus();
      await page.keyboard.press("Space");
      assert.equal(
        await page.locator("#fleet-detail").getAttribute("data-entity-id"),
        "car-28",
      );
      await page.locator("#follow-selected").click();
      assert.equal(
        await page.locator("#follow-selected").getAttribute("aria-pressed"),
        "true",
      );
      await assertCentred(page, "car-28");
      await page.locator("#fleet-map").focus();
      await page.keyboard.press("ArrowLeft");
      assert.equal(
        await page.locator("#follow-selected").getAttribute("aria-pressed"),
        "false",
      );
      await demo.reset();
      assert.equal(
        await demo
          .browser!.page.locator("#follow-selected")
          .getAttribute("aria-pressed"),
        "false",
      );
    } finally {
      await demo.close();
    }
  },
);

test(
  "emulated touch can select a marker and pan out of follow mode",
  { timeout: 60_000 },
  async () => {
    const demo = createVehicleDemo(
      await loadScenario("scenarios/vehicle-fleet-contracts.json"),
      { fleet: true, headless: true },
    );
    try {
      await demo.reset();
      while (demo.state.phase === "ready") await demo.step();
      const page = demo.browser!.page;
      await page.setViewportSize({ width: 390, height: 844 });
      await page.locator("#fit-fleet").click();
      await page.locator("#fleet-map").scrollIntoViewIfNeeded();
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true });
      const marker = (await page
        .locator('.vehicle-map-marker[data-entity-id="car-39"]')
        .boundingBox())!;
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [
          { x: marker.x + marker.width / 2, y: marker.y + marker.height / 2 },
        ],
      });
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
      assert.equal(
        await page.locator("#fleet-detail").getAttribute("data-entity-id"),
        "car-39",
      );
      await page.locator("#follow-selected").click();
      assert.equal(
        await page.locator("#follow-selected").getAttribute("aria-pressed"),
        "true",
      );
      await page.locator("#fleet-map").scrollIntoViewIfNeeded();
      const bounds = (await page.locator("#fleet-map").boundingBox())!;
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x: bounds.x + 70, y: bounds.y + 140 }],
      });
      for (const distance of [20, 40, 60])
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [{ x: bounds.x + 70 + distance, y: bounds.y + 140 }],
        });
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
      assert.equal(
        await page.locator("#follow-selected").getAttribute("aria-pressed"),
        "false",
      );
      await cdp.send("Emulation.setTouchEmulationEnabled", {
        enabled: true,
        maxTouchPoints: 2,
      });
      await page.locator("#follow-selected").click();
      assert.equal(
        await page.locator("#follow-selected").getAttribute("aria-pressed"),
        "true",
      );
      await page.locator("#fleet-map").scrollIntoViewIfNeeded();
      const gestureBounds = (await page.locator("#fleet-map").boundingBox())!;
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [
          { x: gestureBounds.x + 60, y: gestureBounds.y + 120 },
          { x: gestureBounds.x + 130, y: gestureBounds.y + 140 },
        ],
      });
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
      assert.equal(
        await page.locator("#follow-selected").getAttribute("aria-pressed"),
        "false",
      );
      assert.equal(demo.state.phase, "complete");
      await cdp.detach();
    } finally {
      await demo.close();
    }
  },
);
