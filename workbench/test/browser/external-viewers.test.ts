import assert from "node:assert/strict";
import test from "node:test";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { createExternalVehicleDemo } from "../../src/demos/vehicle/external-vehicle-demo.js";
import { loadScenario } from "../../src/scenario/scenario.js";

test(
  "paired browsers have independent views, targeted faults, shared Reset and refresh",
  { timeout: 60_000 },
  async () => {
    const scenario = await loadScenario(
      "scenarios/vehicle-fleet-contracts.json",
    );
    scenario.timeline = scenario.timeline.map((entry) => ({
      ...entry,
      simulationTime: entry.simulationTime * 100 + 10_000,
    }));
    const demo = await createExternalVehicleDemo(scenario, {
      bindAddress: "127.0.0.1",
    });
    const browser = await chromium.launch({ headless: true });
    try {
      await demo.reset();
      const owner = demo.host.pair("Phone", true);
      const guest = demo.host.pair("Desktop");
      const phone = await browser.newPage({
        viewport: { width: 390, height: 844 },
      });
      const desktop = await browser.newPage();
      await phone.goto(owner.url);
      await desktop.goto(guest.url);
      await phone
        .locator("#viewer-role")
        .filter({ hasText: "You control" })
        .waitFor();
      await desktop
        .locator("#viewer-role")
        .filter({ hasText: "Observer" })
        .waitFor();
      assert.equal(new URL(phone.url()).hash, "");
      assert.equal(await desktop.locator("#step").isDisabled(), true);
      await phone.locator("#step").click();
      await phone.waitForFunction(
        () => document.querySelector("#current-sequence")?.textContent === "40",
      );
      await desktop.waitForFunction(
        () => document.querySelector("#current-sequence")?.textContent === "40",
      );
      while (demo.state.phase === "stepping")
        await new Promise((resolve) => setTimeout(resolve, 10));
      while (demo.state.phase === "ready") await demo.command("step");
      await desktop
        .getByRole("button", { name: "Vehicle 28", exact: true })
        .click();
      assert.equal(
        await phone.locator("#fleet-detail").getAttribute("data-entity-id"),
        "car-17",
      );
      await mkdir("test-results", { recursive: true });
      await phone
        .locator("#workbench-controls")
        .screenshot({ path: "test-results/external-controls.png" });
      const oldPath = await desktop
        .locator("body")
        .getAttribute("data-data-path");
      await demo.command("interrupt", guest.id);
      assert.match(
        await desktop.locator("#connection-status").innerText(),
        /reconnecting/,
      );
      assert.match(
        await phone.locator("#connection-status").innerText(),
        /connected/,
      );
      await demo.command("restore", guest.id);
      await desktop
        .locator("#connection-status")
        .filter({ hasText: "ZooGlass connected" })
        .waitFor();
      assert.equal(
        await desktop.locator("#current-sequence").textContent(),
        "40",
      );
      assert.match(
        await desktop.locator("#run-mode").innerText(),
        /exploratory/,
      );

      const pageUrl = phone.url();
      await phone.evaluate("window.samePage = true");
      await demo.reset();
      assert.equal(phone.url(), pageUrl);
      assert.equal(await phone.evaluate("window.samePage"), true);
      assert.notEqual(
        await desktop.locator("body").getAttribute("data-data-path"),
        oldPath,
      );
      assert.equal(
        await desktop.locator("#fleet-detail").getAttribute("data-entity-id"),
        "car-17",
      );
      assert.equal(await phone.locator(".vehicle-map-marker").count(), 0);
      await desktop.reload();
      await desktop
        .locator("#viewer-role")
        .filter({ hasText: "Observer" })
        .waitFor();
      assert.equal(demo.host.list().length, 2);
      demo.host.transfer(guest.id);
      await desktop
        .locator("#viewer-role")
        .filter({ hasText: "You control" })
        .waitFor();
      assert.equal(await phone.locator("#step").isDisabled(), true);
      await desktop.locator("#step").click();
      await phone.waitForFunction(
        () => document.querySelector("#current-sequence")?.textContent === "40",
      );
      demo.host.revoke(owner.id);
      await phone
        .locator("#status")
        .filter({ hasText: "disconnected" })
        .waitFor();
      assert.match(
        await desktop.locator("#connection-status").innerText(),
        /connected/,
      );
      await demo.reset();
      await demo.command("play");
      assert.equal(demo.state.playing, true);
      await desktop.close();
      const deadline = Date.now() + 3000;
      while (demo.state.playing && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(
        demo.state.playing,
        false,
        "controller loss pauses shared playback",
      );
      assert.equal(demo.state.phase, "ready");
    } finally {
      await browser.close();
      await demo.close();
    }
  },
);
