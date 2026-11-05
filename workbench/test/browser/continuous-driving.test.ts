import assert from "node:assert/strict";
import test from "node:test";
import { chromium, webkit } from "playwright";
import { startSimulation } from "../../src/demos/vehicle/continuous/simulation.js";

for (const engine of [chromium, webkit]) {
  test(
    `${engine.name()}: six cars move without controls and late viewers receive snapshots`,
    { timeout: 60_000 },
    async () => {
      const simulation = await startSimulation({ tickMs: 100 });
      const browser = await engine.launch();
      try {
        const page = await browser.newPage({
          viewport: { width: 390, height: 744 },
        });
        page.setDefaultTimeout(10_000);
        await page.addInitScript(`
        const NativeWebSocket = window.WebSocket;
        window.WebSocket = class extends NativeWebSocket {
          constructor(...args) { super(...args); window.testDataSocket = this; }
        };
      `);
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(simulation.origin);
        await page.waitForFunction(
          () => document.querySelectorAll(".car").length === 6,
        );
        assert.equal(
          await page
            .getByRole("button", { name: /^(Play|Pause|Reset|Step)$/ })
            .count(),
          0,
        );
        const before = await page
          .locator('.car[data-entity-id="car-1"]')
          .getAttribute("data-sequence");
        await page.waitForFunction(
          (sequence) =>
            Number(
              document
                .querySelector('.car[data-entity-id="car-1"]')
                ?.getAttribute("data-sequence"),
            ) >
            Number(sequence) + 2,
          before,
        );
        const map = (await page.locator("#map").boundingBox())!;
        assert.ok(
          map.y < 100 && map.height > 400,
          "the map occupies the initial phone screen",
        );
        const credit = (await page.locator("#map-attribution").boundingBox())!;
        assert.ok(
          credit.y + credit.height <= 744,
          "map attribution remains visible on the phone",
        );
        await page.getByRole("button", { name: "Show all cars" }).click();
        await page.waitForTimeout(300); // Leaflet's fit animation.
        for (const marker of await page.locator(".car").all()) {
          const box = (await marker.boundingBox())!;
          assert.ok(box.x >= map.x && box.x + box.width <= map.x + map.width);
          assert.ok(box.y >= map.y && box.y + box.height <= map.y + map.height);
        }
        const beforeOffline = await page
          .locator('.car[data-entity-id="car-1"]')
          .getAttribute("data-sequence");
        await page.context().setOffline(true);
        await page.evaluate("window.testDataSocket.close()");
        // Disconnected text lasts only until the next retry. Retained markers
        // stay stale throughout the offline period, even on a busy CI runner.
        await page.waitForFunction(
          () => document.querySelectorAll(".car.stale").length === 6,
        );
        // Offline markers are stationary. Choose a visible click target rather
        // than forcing a click through a car which overlaps the intended marker.
        const markerLabel = await page
          .locator(".car")
          .evaluateAll((markers) => {
            const marker = markers.find((candidate) => {
              const box = candidate.getBoundingClientRect();
              const hit = document.elementFromPoint(
                box.x + box.width / 2,
                box.y + box.height / 2,
              );
              return hit?.closest(".car") === candidate;
            });
            return marker?.getAttribute("aria-label");
          });
        assert.ok(markerLabel, "at least one car can be selected by pointer");
        await page
          .getByRole("button", { name: markerLabel, exact: true })
          .click();
        const selectedName = markerLabel.replace(/^Inspect /, "");
        assert.ok(
          (await page.locator("#selection").innerText()).startsWith(
            `${selectedName} ·`,
          ),
          "selection describes the car that received the pointer click",
        );

        await page.context().setOffline(false);
        await page.waitForFunction(
          (sequence) =>
            Number(
              document
                .querySelector('.car[data-entity-id="car-1"]')
                ?.getAttribute("data-sequence"),
            ) > Number(sequence),
          beforeOffline,
        );
        await page.waitForFunction(
          () => document.querySelectorAll(".car:not(.stale)").length > 0,
        );

        // Observe the actual close event rather than polling transient status text.
        await page.evaluate(`new Promise(resolve => {
          window.testDataSocket.addEventListener("close", resolve, { once: true });
          window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
        })`);
        await page.evaluate(() =>
          window.dispatchEvent(
            new PageTransitionEvent("pageshow", { persisted: true }),
          ),
        );
        await page
          .locator("#connection")
          .filter({ hasText: "Receiving positions" })
          .waitFor();
        await page.waitForFunction(
          () => document.querySelectorAll(".car:not(.stale)").length > 0,
        );
        await page.close();
        const viewer = await browser.newPage();
        await viewer.goto(simulation.origin);
        await viewer.waitForFunction(
          () => document.querySelectorAll(".car").length === 6,
        );
        assert.ok(
          Number(
            await viewer
              .locator('.car[data-entity-id="car-1"]')
              .getAttribute("data-sequence"),
          ) > Number(before),
        );
        assert.deepEqual(errors, []);
      } finally {
        await browser.close();
        await simulation.close();
      }
    },
  );
}

test("a fresh empty baseline clears only its car after reconnect", async () => {
  const simulation = await startSimulation();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const car = page.locator('.car[data-entity-id="car-1"]');
    let connections = 0;
    await page.routeWebSocket("**/views/live", (socket) => {
      const generation = ++connections;
      socket.onMessage((request) => {
        const { viewId, entityId } = JSON.parse(String(request));
        const empty = generation > 1 && entityId === "car-1";
        socket.send(
          JSON.stringify({
            type: "subscribed",
            recovery: "freshSnapshot",
            viewId,
            entityId,
          }),
        );
        socket.send(
          JSON.stringify({
            type: "view-update",
            viewId,
            entityId,
            version: empty ? 0 : 1,
            data: empty
              ? {}
              : {
                  position: {
                    sequence: 1,
                    latitude: 36.145,
                    longitude: -5.354,
                    observedAt: Date.now(),
                  },
                },
          }),
        );
      });
    });
    await page.goto(simulation.origin);
    await page.waitForFunction(
      () => document.querySelectorAll(".car").length === 6,
    );
    await car.dispatchEvent("click");
    await page.locator("#selection").waitFor();
    await page.evaluate(() =>
      document.dispatchEvent(new Event("visibilitychange")),
    );
    await car.waitFor({ state: "detached", timeout: 5000 });
    assert.equal(connections, 2);
    assert.equal(await page.locator("#selection").isHidden(), true);
    assert.equal(await page.locator(".car").count(), 5);
  } finally {
    await browser.close();
    await simulation.close();
  }
});
