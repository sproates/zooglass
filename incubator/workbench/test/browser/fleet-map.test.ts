import assert from "node:assert/strict";
import test from "node:test";
import { loadScenario } from "../../src/scenario/scenario.js";
import { createVehicleDemo } from "../../src/demos/vehicle/vehicle-demo.js";

// Independent Web Mercator calculation, not the application's model or Leaflet API.
function project(latitude: number, longitude: number) {
  const size = 256 * 2 ** 16;
  const sine = Math.sin((latitude * Math.PI) / 180);
  return {
    x: ((longitude + 180) / 360) * size,
    y: (0.5 - Math.log((1 + sine) / (1 - sine)) / (4 * Math.PI)) * size,
  };
}

test(
  "fleet map renders received geometry and shares local selection",
  { timeout: 60_000 },
  async () => {
    const demo = createVehicleDemo(
      await loadScenario("scenarios/vehicle-fleet-contracts.json"),
      { fleet: true, headless: true },
    );
    try {
      await demo.reset();
      const page = demo.browser!.page;
      assert.equal(
        await page.locator(".vehicle-map-marker").count(),
        0,
        "manifest metadata cannot manufacture positions",
      );
      while (demo.state.phase === "ready") await demo.step();
      assert.equal(demo.state.phase, "complete");
      assert.equal(await page.locator(".vehicle-map-marker").count(), 3);

      const bounds = (await page.locator("#fleet-map").boundingBox())!;
      const centre = project(36.141, -5.3535);
      const expectedPoint = (latitude: number, longitude: number) => {
        const point = project(latitude, longitude);
        return {
          x: bounds.x + bounds.width / 2 + point.x - centre.x,
          y: bounds.y + bounds.height / 2 + point.y - centre.y,
        };
      };
      for (const [id, latitude, longitude] of [
        ["car-17", 36.1412, -5.3532],
        ["car-28", 36.1432, -5.3544],
        ["car-39", 36.1389, -5.3526],
      ] as const) {
        const marker = (await page
          .locator(`.vehicle-map-marker[data-entity-id="${id}"]`)
          .boundingBox())!;
        const expected = expectedPoint(latitude, longitude);
        assert.ok(
          Math.abs(marker.x + marker.width / 2 - expected.x) <= 2,
          `${id} longitude`,
        );
        assert.ok(
          Math.abs(marker.y + marker.height - expected.y) <= 2,
          `${id} pointer tip latitude`,
        );
      }

      const path = page.locator(".fleet-received-route");
      const vertices = await path.evaluate((node) => {
        const path = node as SVGPathElement;
        const matrix = path.getScreenCTM()!;
        const numbers = path
          .getAttribute("d")!
          .match(/-?\d+(?:\.\d+)?/g)!
          .map(Number);
        const points = [];
        for (let i = 0; i < numbers.length; i += 2) {
          const point = new DOMPoint(
            numbers[i],
            numbers[i + 1],
          ).matrixTransform(matrix);
          points.push({ x: point.x, y: point.y });
        }
        return points;
      });
      const history = [
        [36.1408, -5.3536],
        [36.141, -5.3534],
        [36.1412, -5.3532],
      ];
      assert.equal(
        vertices.length,
        3,
        "late 41 fills the route; duplicate coordinates cannot replace accepted facts",
      );
      for (const [index, [latitude, longitude]] of history.entries()) {
        const expected = expectedPoint(latitude, longitude);
        assert.ok(
          Math.abs(vertices[index].x - expected.x) <= 2,
          JSON.stringify({ actual: vertices[index], expected }),
        );
        assert.ok(Math.abs(vertices[index].y - expected.y) <= 2);
      }

      const connections: string[] = [];
      page.on("websocket", (socket) => {
        connections.push(socket.url());
      });
      // Existing socket sends are observed through the real browser socket.
      await page.evaluate(() => {
        const original = WebSocket.prototype.send;
        (window as unknown as { selectionSends: number }).selectionSends = 0;
        WebSocket.prototype.send = function (data) {
          if (this.url.includes("/views/live?"))
            (window as unknown as { selectionSends: number }).selectionSends++;
          return original.call(this, data);
        };
      });
      await page
        .getByRole("button", { name: "Select Vehicle 28 on map", exact: true })
        .click();
      assert.equal(
        await page.locator("#fleet-detail").getAttribute("data-entity-id"),
        "car-28",
      );
      assert.equal(
        await page
          .getByRole("button", { name: "Vehicle 28", exact: true })
          .getAttribute("aria-pressed"),
        "true",
      );
      assert.equal(await page.locator("#history li").count(), 1);
      assert.equal(
        (await path.getAttribute("d"))!.match(/-?\d+(?:\.\d+)?/g)!.length,
        2,
      );
      await page
        .getByRole("button", { name: "Vehicle 39", exact: true })
        .click();
      assert.equal(
        await page
          .getByRole("button", {
            name: "Select Vehicle 39 on map",
            exact: true,
          })
          .getAttribute("aria-pressed"),
        "true",
      );
      assert.match(
        await page.locator("#map-status").innerText(),
        /Vehicle 39: 2 received positions/,
      );

      assert.equal(
        (await path.getAttribute("d"))!.match(/-?\d+(?:\.\d+)?/g)!.length,
        4,
      );
      assert.equal(
        await page.evaluate(
          () =>
            (window as unknown as { selectionSends: number }).selectionSends,
        ),
        0,
      );
      assert.deepEqual(
        connections,
        [],
        "selection must not open a replacement socket",
      );

      const resources = await page.evaluate(() =>
        performance.getEntriesByType("resource").map((entry) => entry.name),
      );
      assert.ok(resources.some((url) => url.endsWith("/map-tile.svg")));
      assert.ok(
        resources.every(
          (url) => new URL(url).origin === new URL(page.url()).origin,
        ),
        "automated runs must not contact public tile services",
      );
      await demo.disconnect();
      assert.equal(
        await page.locator(".vehicle-map-marker.retained").count(),
        3,
      );
      assert.match(
        await page.locator("#map-status").innerText(),
        /Last received/,
      );
      await demo.reset();
      assert.equal(
        await demo.browser!.page.locator(".vehicle-map-marker").count(),
        0,
      );
    } finally {
      await demo.close();
    }
  },
);
