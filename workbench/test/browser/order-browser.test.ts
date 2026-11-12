import assert from "node:assert/strict";
import test from "node:test";
import { chromium, firefox, webkit, type Browser, type Page } from "playwright";
import { startOrderBrowser } from "../../src/demos/orders/browser.js";

async function observe(page: Page) {
  await page.addInitScript(`
    window.orderUpdates = [];
    document.addEventListener('order-observation', event => {
      if (event.detail.event === 'view-update') {
        window.orderUpdates.push(event.detail);
        if (window.orderUpdates.length > 100) window.orderUpdates.shift();
      }
    });
  `);
}

test(
  "Order browser renders full metadata, status-only freshness and first recovery baselines",
  { timeout: 70_000 },
  async () => {
    let stopAt = 0;
    let release = () => {};
    let reached = -1;
    let atCheckpoint = () => {};
    const advanceTo = (tick: number) =>
      new Promise<void>((resolve) => {
        stopAt = tick;
        atCheckpoint = resolve;
        release();
      });
    const controller = new AbortController();
    const demo = await startOrderBrowser({
      tickMs: 15,
      cycles: 3,
      signal: controller.signal,
      onStep: async (step) => {
        reached = step.tick;
        if (step.tick !== stopAt) return;
        await new Promise<void>((resolve) => {
          release = resolve;
          controller.signal.addEventListener("abort", () => resolve(), {
            once: true,
          });
          atCheckpoint();
        });
      },
    });
    let browser: Browser | undefined;
    try {
      browser = await chromium.launch();
      const page = await browser.newPage({
        viewport: { width: 1440, height: 1000 },
      });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await observe(page);
      await page.goto(demo.origin);
      await page.waitForFunction(
        () =>
          document.getElementById("connection")?.textContent ===
          "Receiving live snapshots",
      );
      assert.equal(await page.locator("#startup").isVisible(), false);
      assert.equal(await page.locator("#playback").isVisible(), false);
      assert.equal(await page.locator("#orders .order-row").count(), 6);
      await page.locator('[data-view="tracking"]').click();
      assert.match(
        await page.locator("#tracking").innerText(),
        /Waiting for tracking information/,
      );
      assert.equal(await page.locator("#tracking .tracking-facts").count(), 0);
      await advanceTo(5);
      await page.waitForFunction(
        () =>
          document.querySelector('#tracking [data-field="inventory"] span')
            ?.textContent === "Reserved",
      );
      await page.locator('[data-view="operations"]').click();
      await page.waitForFunction(
        `window.orderUpdates.some(s => s.viewId === 'order-summary' && s.entityId === 'order-1' && s.publicationSequences.delivery?.[0] === 1)`,
      );
      await page.waitForFunction(
        () =>
          document.querySelector(
            '#orders [data-order="order-1"] [data-field="inventory"] em',
          )?.textContent === "Last known · stale",
        undefined,
        { timeout: 22_000 },
      );
      assert.equal(
        await page
          .locator(
            '#orders [data-order="order-1"] [data-field="inventory"] span',
          )
          .innerText(),
        "Reserved",
      );
      const metadata = await page.evaluate(
        `window.orderUpdates.filter(s => s.viewId === 'order-summary' && s.entityId === 'order-1').at(-1)`,
      );
      assert.equal(metadata.provenance.delivery.sourceId, "courier-primary");
      assert.deepEqual(metadata.publicationSequences.delivery, [1]);
      assert.equal(metadata.status.fields.inventory.freshness, "stale");
      assert.equal(
        reached,
        5,
        "freshness changed without another source checkpoint",
      );
      await page.locator('[data-view="tracking"]').click();
      assert.match(
        await page.locator('#tracking [data-field="inventory"]').innerText(),
        /Last known · stale/,
      );
      assert.equal(
        await page.locator('#tracking [data-field="payment"]').count(),
        0,
      );
      await demo.setDataBlocked(true);
      await page.waitForFunction(() =>
        document
          .getElementById("connection")
          ?.textContent?.includes("Disconnected"),
      );
      await advanceTo(34);
      const expected = await fetch(
        `${demo.baseUrl}/views/order-summary/order-1`,
      ).then((response) => response.json());
      assert.equal(expected.data.delivery.status, "delivered");
      await page.evaluate("window.orderUpdates = []");
      await demo.setDataBlocked(false);
      await page.waitForFunction(
        () =>
          document.getElementById("connection")?.textContent ===
          "Receiving live snapshots",
      );
      const first = await page.evaluate(
        `window.orderUpdates.find(s => s.viewId === 'order-summary' && s.entityId === 'order-1')`,
      );
      assert.deepEqual(first.data, expected.data);
      assert.deepEqual(first.provenance, expected.provenance);
      assert.deepEqual(
        first.publicationSequences,
        expected.publicationSequences,
      );
      const gap = await page.evaluate(
        `window.orderUpdates.find(s => s.viewId === 'order-summary' && s.entityId === 'order-2').status.inputs.payments.missingRanges`,
      );
      assert.deepEqual(gap, [{ from: 2, through: 2, status: "confirmed" }]);
      const late = await browser.newPage();
      await late.goto(demo.origin);
      await late.waitForFunction(
        () =>
          document.querySelector(
            '#orders [data-order="order-1"] [data-field="delivery"] span',
          )?.textContent === "Delivered",
      );
      assert.equal(
        reached,
        34,
        "recovery and late viewer used baselines with producers paused",
      );
      assert.equal(
        (
          await fetch(`${demo.origin}/activity.json`).then((response) =>
            response.json(),
          )
        ).length,
        20,
      );
      await late.close();
      await advanceTo(36);
      await page.locator('[data-view="operations"]').click();
      await page.waitForFunction(() =>
        document
          .querySelector(
            '#orders [data-order="order-1"] [data-field="payment"] em',
          )
          ?.textContent?.includes("Previous cycle"),
      );
      stopAt = -1;
      release();
      await demo.done;
      assert.equal(
        reached,
        107,
        "Three complete cycles finished before recovery",
      );
      await demo.setDataBlocked(true);
      await page.waitForFunction(() =>
        document
          .getElementById("connection")
          ?.textContent?.includes("Disconnected"),
      );
      await page.evaluate("window.orderUpdates = []");
      await demo.setDataBlocked(false);
      await page.waitForFunction(
        () =>
          document.getElementById("connection")?.textContent ===
          "Receiving live snapshots",
      );
      const finalLate = await browser.newPage();
      await observe(finalLate);
      await finalLate.goto(demo.origin);
      await finalLate.waitForFunction(
        () =>
          document.getElementById("connection")?.textContent ===
          "Receiving live snapshots",
      );
      for (const viewer of [page, finalLate]) {
        const firstSnapshots = await viewer.evaluate(
          `(() => {
            const first = new Map();
            for (const snapshot of window.orderUpdates) {
              const key = snapshot.viewId + '/' + snapshot.entityId;
              if (!first.has(key)) first.set(key, snapshot);
            }
            return [...first.values()];
          })()`,
        );
        assert.equal(firstSnapshots.length, 12);
        // Independent expected outcomes: never ask the producer to compute its own oracle.
        for (const snapshot of firstSnapshots) {
          const id = Number(snapshot.entityId.slice(6));
          assert.equal(snapshot.data.order.cycle, 3);
          assert.equal(snapshot.data.order.reference, `DEMO-3-${id}`);
          assert.equal(
            snapshot.data.order.status,
            [3, 6].includes(id) ? "cancelled" : "dispatched",
          );
          assert.equal(
            snapshot.data.inventory.status,
            id === 3 ? "unavailable" : id === 6 ? "released" : "reserved",
          );
          assert.equal(snapshot.data.inventory.cycle, 3);
          assert.equal(
            snapshot.data.delivery.status,
            [3, 6].includes(id) ? "cancelled" : "delivered",
          );
          assert.equal(
            snapshot.provenance.delivery.sourceId,
            "courier-primary",
          );
          assert.deepEqual(snapshot.publicationSequences.order, [
            id === 6 ? 12 : 9,
          ]);
          assert.deepEqual(snapshot.publicationSequences.inventory, [6]);
          assert.deepEqual(snapshot.publicationSequences.delivery, [6]);
          assert.equal(snapshot.status.publication, "ready");
          if (snapshot.viewId === "order-summary") {
            assert.equal(
              snapshot.data.payment.status,
              id === 3 ? "declined" : id === 6 ? "refunded" : "authorised",
            );
            assert.deepEqual(snapshot.publicationSequences.payment, [12]);
            assert.deepEqual(
              snapshot.status.inputs.payments.missingRanges,
              id === 2 ? [{ from: 2, through: 2, status: "confirmed" }] : [],
            );
          } else assert.equal(snapshot.data.payment, undefined);
        }
        assert.equal(await viewer.locator("#orders .order-row").count(), 6);
      }
      assert.equal(
        reached,
        107,
        "No publication followed either viewer's first baselines",
      );
      assert.equal(
        (await fetch(`${demo.origin}/activity.json`).then((r) => r.json()))
          .length,
        20,
      );
      await finalLate.close();
      await page.close();
      assert.deepEqual(errors, []);
    } finally {
      controller.abort();
      release();
      try {
        await browser?.close();
      } finally {
        await demo.close();
      }
    }
    await assert.rejects(fetch(demo.origin));
    await assert.rejects(fetch(`${demo.baseUrl}/actuator/health`));
  },
);

for (const engine of [chromium, firefox, webkit]) {
  test(
    `${engine.name()}: live Order phone layout, focus and startup failure states`,
    { timeout: 40_000 },
    async () => {
      const demo = await startOrderBrowser({ tickMs: 15, cycles: 1 });
      let browser: Browser | undefined;
      try {
        browser = await engine.launch();
        await demo.done;
        const page = await browser.newPage({
          viewport: { width: 390, height: 844 },
        });
        await page.goto(demo.origin);
        await page.waitForFunction(
          () =>
            document.getElementById("connection")?.textContent ===
            "Receiving live snapshots",
        );
        await page.locator('#orders [data-order="order-2"]').focus();
        await page.keyboard.press("Enter");
        assert.equal(
          await page
            .getByRole("dialog", { name: "order-2 details", exact: true })
            .count(),
          1,
        );
        await page.keyboard.press("Escape");
        assert.equal(
          await page.evaluate(
            () => (document.activeElement as HTMLElement).dataset.order,
          ),
          "order-2",
        );
        for (const width of [360, 390, 760, 761, 1024, 1440]) {
          await page.setViewportSize({ width, height: 1000 });
          for (const view of ["operations", "tracking"]) {
            await page.locator(`button[data-view="${view}"]`).click();
            assert.ok(
              await page.evaluate(
                () => document.documentElement.scrollWidth <= innerWidth,
              ),
              `${view} at ${width}`,
            );
          }
        }
        await page.close();
        const unsupported = await browser.newPage();
        await unsupported.addInitScript("window.HTMLDialogElement = undefined");
        await unsupported.goto(demo.origin);
        assert.match(
          await unsupported.locator("#startup").innerText(),
          /Browser requirements/,
        );
        assert.equal(await unsupported.locator(".order-row").count(), 0);
        await unsupported.close();
        const failed = await browser.newPage();
        await failed.route("**/order-tracker/src/app.js", (route) =>
          route.abort(),
        );
        await failed.goto(demo.origin);
        await failed.waitForFunction(() =>
          document
            .getElementById("startup")
            ?.textContent?.includes("assets could not load"),
        );
        assert.doesNotMatch(
          await failed.locator("#startup").innerText(),
          /unsupported/i,
        );
        await failed.close();
      } finally {
        try {
          await browser?.close();
        } finally {
          await demo.close();
        }
      }
    },
  );
}
