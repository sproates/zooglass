import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createVehicleDemo } from "../../src/demos/vehicle/vehicle-demo.js";
import { loadScenario } from "../../src/scenario/scenario.js";
import { mkdir } from "node:fs/promises";

for (const variant of ["basic", "journey"]) {
  test(
    `${variant}: interactive rendered checkpoints pass again after reset`,
    { timeout: 90_000 },
    async () => {
      const scenario = await loadScenario(
        fileURLToPath(
          new URL(
            `../../scenarios/vehicle-browser-${variant}.json`,
            import.meta.url,
          ),
        ),
      );
      const demo = createVehicleDemo(scenario, { headless: true });

      try {
        for (let run = 0; run < 2; run++) {
          await demo.reset();

          assert.equal(
            await demo.browser!.page.locator("#history li").count(),
            0,
          );
          while (demo.state.phase === "ready") await demo.step();

          assert.equal(demo.state.phase, "complete");
          assert.equal(demo.state.completed, variant === "basic" ? 2 : 20);
        }
      } catch (error) {
        await mkdir("test-results", { recursive: true });
        await demo.browser?.page
          .screenshot({
            path: `test-results/${variant}-assertions.png`,
            fullPage: true,
          })
          .catch(() => {});
        throw error;
      } finally {
        await demo.close();
      }
    },
  );
}

test(
  "correct receipts cannot pass a broken marker; failure stops advance and reset restores verification",
  { timeout: 90_000 },
  async () => {
    const scenario = await loadScenario(
      fileURLToPath(
        new URL("../../scenarios/vehicle-browser-basic.json", import.meta.url),
      ),
    );
    const demo = createVehicleDemo(scenario, { headless: true });

    try {
      await demo.reset();

      const page = demo.browser!.page;

      await page.evaluate(() => {
        const marker = document.getElementById("vehicle-marker")!;
        new MutationObserver(() => {
          if (marker.getAttribute("cx") !== "999")
            marker.setAttribute("cx", "999");
        }).observe(marker, { attributes: true, attributeFilter: ["cx"] });
      });

      await assert.rejects(
        demo.step(),
        /Rendered check failed.*marker coordinate 0/s,
      );
      assert.equal(
        await page.locator("#current-sequence").textContent(),
        "40",
        "the real snapshot reached the app",
      );
      assert.equal(demo.state.phase, "failed");
      assert.equal(demo.state.completed, 0);
      await assert.rejects(demo.step(), /idle/);
      await demo.reset();
      await demo.step();

      assert.equal(demo.state.completed, 1);
    } finally {
      await demo.close();
    }
  },
);

test(
  "reset cancels a pending rendered check without advancing the new run",
  { timeout: 90_000 },
  async () => {
    const scenario = await loadScenario(
      fileURLToPath(
        new URL("../../scenarios/vehicle-browser-basic.json", import.meta.url),
      ),
    );
    const demo = createVehicleDemo(scenario, { headless: true });

    try {
      await demo.reset();

      const page = demo.browser!.page;

      await page.evaluate(
        "document.getElementById('vehicle-marker').style.visibility = 'hidden'",
      );

      const step = demo.step();
      const rejected = assert.rejects(step);

      await page.waitForFunction(
        () => document.querySelector("#current-sequence")!.textContent === "40",
        undefined,
        { timeout: 5000 },
      );

      assert.equal(demo.state.phase, "stepping");
      await demo.reset();
      await rejected;

      assert.equal(demo.state.completed, 0);
      assert.equal(demo.state.phase, "ready");
      await demo.step();

      assert.equal(demo.state.completed, 1);
    } finally {
      await demo.close();
    }
  },
);
