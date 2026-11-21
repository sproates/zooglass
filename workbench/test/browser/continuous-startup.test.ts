import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { startSimulation } from "../../src/demos/vehicle/continuous/simulation.js";

test(
  "continuous Fleet reports mandatory startup failures and recovers after reload",
  { timeout: 60_000 },
  async (t) => {
    const simulation = await startSimulation({ tickMs: 100 });
    t.after(() => simulation.close());
    const browser = await chromium.launch();
    t.after(() => browser.close());
    for (const asset of [
      "/driving/bootstrap.js",
      "/driving/app.js",
      "/cars.json",
      "/map-config.json",
    ]) {
      const page = await browser.newPage();
      await page.route(`**${asset}`, (route) =>
        route.fulfill({ status: 503, body: "Unavailable" }),
      );
      await page.goto(simulation.origin);
      await page.waitForFunction(
        () =>
          /could not (load|start)/.test(
            document.getElementById("startup")?.textContent ?? "",
          ),
        null,
        { timeout: 3000 },
      );
      assert.match(await page.locator("#startup").innerText(), /reload/i);
      await page.unroute(`**${asset}`);
      await page.reload();
      await page.waitForFunction(
        () => document.querySelectorAll(".car").length === 6,
      );
      assert.equal(await page.locator("#startup").isVisible(), false);
      await page.close();
    }
    const missingLoader = await browser.newPage();
    await missingLoader.route("**/driving/startup.js", (route) =>
      route.abort(),
    );
    await missingLoader.goto(simulation.origin);
    assert.match(
      await missingLoader.locator("#startup").innerText(),
      /check the demo server and reload/,
    );
    await missingLoader.close();
    const delayed = await browser.newPage();
    let release!: () => void;
    let observed!: () => void;
    const requested = new Promise<void>((resolve) => {
      observed = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await delayed.route("**/cars.json", async (route) => {
      observed();
      await gate;
      await route.continue();
    });
    try {
      await delayed.goto(simulation.origin, {
        waitUntil: "domcontentloaded",
      });
      await requested;
      assert.equal(
        await delayed.locator("#startup").innerText(),
        "Loading Fleet viewer…",
      );
    } finally {
      release();
    }
    await delayed.waitForFunction(
      () => document.querySelectorAll(".car").length === 6,
    );
    assert.equal(await delayed.locator("#startup").isVisible(), false);
    await delayed.close();

    const unsupported = await browser.newPage();
    await unsupported.addInitScript(() => {
      Object.defineProperty(window, "ResizeObserver", { value: undefined });
    });
    const modules: string[] = [];
    unsupported.on("request", (request) => {
      if (request.url().includes("/driving/")) {
        modules.push(request.url());
      }
    });
    await unsupported.goto(simulation.origin);
    assert.match(
      await unsupported.locator("#startup").innerText(),
      /requires Chrome/,
    );
    assert.deepEqual(
      modules.filter((url) => !url.endsWith("/startup.js")),
      [],
    );
    await unsupported.close();
  },
);
