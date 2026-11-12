import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { chromium, firefox, webkit, type Browser } from "playwright";
import { startInteractiveSports } from "../../src/demos/sports/interactive.js";
import { startSportsSimulation } from "../../src/demos/sports/simulation.js";
import { sportsCheckpoints } from "../../src/demos/sports/checkpoints.js";
import type { SportsStep } from "../../src/demos/sports/timeline.js";

async function until(check: () => boolean, timeout = 25000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    assert.ok(Date.now() < deadline, "Timed out waiting for Sports state");
    await delay(20);
  }
}
function deliveries(step: SportsStep) {
  return {
    ...step,
    actions: step.actions.map((action) =>
      action.kind !== "publish"
        ? action
        : {
            ...action,
            event: {
              ...action.event,
              payload: { ...action.event.payload, observedAt: 0 },
            },
          },
    ),
  };
}

test(
  "Sports walkthrough checks outcomes, pauses pending freshness, completes and resets all viewers",
  { timeout: 65000 },
  async (t) => {
    const delivered: unknown[] = [];
    const demo = await startInteractiveSports({
      signal: t.signal,
      delayBefore: 10,
      onStep(step) {
        if (step.cycle === 1) delivered.push(deliveries(step));
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
      await page.goto(demo.origin);
      await page.locator("#step").click();
      await until(() => demo.state.completed === 1);
      for (let i = 1; i < 7; i++) await demo.command("step");
      await page.locator('[data-view="comparison"]').click();
      await page.waitForFunction(
        () =>
          Array.from(document.querySelectorAll(".policy-score"))
            .map((e) => e.textContent)
            .join() === "1–0,2–0",
      );
      const late = await browser.newPage();
      await late.goto(demo.origin);
      await late.waitForFunction(() =>
        document
          .getElementById("checkpoint-label")
          ?.textContent?.startsWith("7/21"),
      );
      await page.locator("#play").click();
      await until(
        () => demo.state.completed === 13 && demo.state.phase === "stepping",
      );
      await page.locator("#pause").click();
      await until(() => !demo.state.playing);
      assert.equal(
        demo.state.phase,
        "stepping",
        "Pause must await real freshness verification",
      );
      await until(
        () => demo.state.completed === 14 && demo.state.phase === "ready",
      );
      await delay(100);
      assert.equal(demo.state.completed, 14);
      await page.locator("#play").click();
      await until(() => demo.state.phase === "complete");
      assert.equal(demo.state.completed, sportsCheckpoints.length);
      await page.waitForFunction(
        () => (document.getElementById("step") as HTMLButtonElement).disabled,
      );
      assert.equal(await page.locator("#play").isDisabled(), true);
      assert.equal(await page.locator("#reset").isEnabled(), true);
      const oldBase = demo.baseUrl;
      await page.locator("#reset").click();
      await until(
        () => demo.state.phase === "ready" && demo.state.completed === 0,
      );
      await assert.rejects(fetch(`${oldBase}/actuator/health`));
      for (const viewer of [page, late])
        await viewer.waitForFunction(
          () =>
            document
              .getElementById("checkpoint-label")
              ?.textContent?.startsWith("0/21") &&
            document.getElementById("connection")?.textContent ===
              "Receiving live snapshots",
        );
      assert.deepEqual(await page.locator(".policy-score").allTextContents(), [
        "—–—",
        "—–—",
      ]);
      await page.locator("#step").click();
      await until(() => demo.state.completed === 1);
      assert.equal(page.url(), `${demo.origin}/`);
      assert.deepEqual(errors, []);
    } finally {
      await browser?.close();
      await demo.close();
    }
    const continuous: unknown[] = [];
    const simulation = await startSportsSimulation({
      tickMs: 10,
      cycles: 1,
      signal: t.signal,
      onStep(step) {
        continuous.push(deliveries(step));
      },
    });
    try {
      await simulation.done;
    } finally {
      await simulation.close();
    }
    assert.deepEqual(
      delivered.slice(0, continuous.length),
      continuous,
      "Both modes use identical first-cycle deliveries",
    );
  },
);

test(
  "Sports Reset cancels pending checks, clears failure and retires old service/store",
  { timeout: 40000 },
  async (t) => {
    let fail = true;
    const demo = await startInteractiveSports({
      signal: t.signal,
      delayBefore: 0,
      onStep(step) {
        if (fail && step.name === "first-goal")
          throw new Error("Injected Sports failure");
      },
    });
    try {
      for (let i = 0; i < 3; i++) await demo.command("step");
      await assert.rejects(demo.command("step"), /Injected Sports failure/);
      assert.equal(demo.state.phase, "failed");
      assert.equal(demo.state.completed, 3);
      fail = false;
      await demo.command("reset");
      for (let i = 0; i < 13; i++) await demo.command("step");
      const pending = demo.command("step");
      const cancelled = assert.rejects(pending);
      await until(() => demo.state.phase === "stepping");
      const oldBase = demo.baseUrl;
      await demo.command("reset");
      await cancelled;
      assert.equal(demo.state.completed, 0);
      await assert.rejects(fetch(`${oldBase}/actuator/health`));
      await demo.command("step");
      await delay(100);
      assert.equal(demo.state.completed, 1);
      for (let i = 1; i < 13; i++) await demo.command("step");
      const interrupted = assert.rejects(demo.command("step"));
      await until(() => demo.state.phase === "stepping");
      await demo.close();
      await interrupted;
      await demo.done;
      await assert.rejects(fetch(demo.origin));
      await assert.rejects(fetch(`${demo.baseUrl}/actuator/health`));
    } finally {
      await demo.close();
    }
  },
);

for (const engine of [chromium, firefox, webkit])
  test(
    `${engine.name()}: Sports phone controls retain stable URL across Reset`,
    { timeout: 30000 },
    async (t) => {
      const demo = await startInteractiveSports({
        signal: t.signal,
        delayBefore: 0,
      });
      let browser: Browser | undefined;
      try {
        browser = await engine.launch();
        const page = await browser.newPage({
          viewport: { width: 390, height: 844 },
        });
        await page.goto(demo.origin);
        await page.locator("#step").click();
        await until(() => demo.state.completed === 1);
        await page.locator("#reset").click();
        await page.waitForFunction(
          () =>
            document
              .getElementById("checkpoint-label")
              ?.textContent?.startsWith("0/21") &&
            !(document.getElementById("step") as HTMLButtonElement).disabled,
        );
        for (const width of [360, 390, 651, 768, 1440]) {
          await page.setViewportSize({ width, height: 1000 });
          for (const view of ["board", "scoreboard", "comparison"]) {
            await page.locator(`[data-view="${view}"]`).click();
            assert.ok(
              await page.evaluate(() => {
                const controls = document
                  .getElementById("playback")!
                  .getBoundingClientRect();
                const content = [
                  "matches",
                  "board-content",
                  "scoreboard-note",
                  "comparison",
                ]
                  .map((id) => document.getElementById(id)!)
                  .filter((element) => element.getClientRects().length > 0);
                return (
                  content.every(
                    (element) =>
                      element.getBoundingClientRect().bottom <= controls.top,
                  ) &&
                  controls.bottom <=
                    document
                      .querySelector("section.notice")!
                      .getBoundingClientRect().top
                );
              }),
              `${engine.name()}/${width}/${view}: match content precedes controls and notices`,
            );
            assert.ok(
              await page.evaluate(
                () => document.documentElement.scrollWidth <= innerWidth,
              ),
            );
          }
        }
        const rejection = await page.evaluate(
          () =>
            new Promise<string>((resolve, reject) => {
              const socket = new WebSocket(
                location.origin.replace("http", "ws") + "/controls",
              );
              const timer = setTimeout(() => {
                socket.close();
                reject(new Error("Command rejection timed out"));
              }, 3000);
              socket.onopen = () =>
                socket.send(JSON.stringify({ action: "step", generation: -1 }));
              socket.onmessage = (event) => {
                const data = JSON.parse(event.data);
                if (data.kind === "error") {
                  clearTimeout(timer);
                  socket.close();
                  resolve(data.detail);
                }
              };
            }),
        );
        assert.match(rejection, /replaced run/);
        assert.equal(demo.state.completed, 0);
      } finally {
        await browser?.close();
        await demo.close();
      }
    },
  );

test(
  "Sports partial retirement failure stays visible and Reset startup failure remains retryable",
  { timeout: 50000 },
  async (t) => {
    const { controlExchange } =
      await import("../../src/execution/control-request.js");
    let exchange: ReturnType<typeof controlExchange>;
    let fail = true;
    const demo = await startInteractiveSports({
      signal: t.signal,
      delayBefore: 0,
      onService(service) {
        exchange = controlExchange(service.baseUrl, service.signal);
      },
      exchange(path, control) {
        const request = control as { viewId?: string };
        return exchange(
          path,
          fail && path === "/facts/retire" && request.viewId === "scoreboard"
            ? { ...request, fields: ["missing"] }
            : control,
        );
      },
    });
    const javaHome = process.env.JAVA_HOME;
    let browser: Browser | undefined;
    try {
      for (let i = 0; i < 16; i++) await demo.command("step");
      await assert.rejects(demo.command("step"), /Fact retirement failed/);
      assert.equal(demo.state.phase, "failed");
      assert.equal(demo.state.completed, 16);
      browser = await chromium.launch();
      const page = await browser.newPage();
      await page.goto(demo.origin);
      await page.waitForFunction(() =>
        document
          .getElementById("control-detail")
          ?.textContent?.includes("Fact retirement failed"),
      );
      await page.locator('[data-view="comparison"]').click();
      await page.waitForFunction(
        () =>
          Array.from(document.querySelectorAll(".policy-score"))
            .map((e) => e.textContent)
            .join() === "—–—,—–—",
      );
      assert.equal(await page.locator("#reset").isEnabled(), true);
      assert.equal(await page.locator("#step").isDisabled(), true);
      const oldBase = demo.baseUrl;
      try {
        process.env.JAVA_HOME = process.execPath;
        await assert.rejects(demo.command("reset"), /spawn/);
      } finally {
        if (javaHome === undefined) delete process.env.JAVA_HOME;
        else process.env.JAVA_HOME = javaHome;
      }
      await assert.rejects(fetch(`${oldBase}/actuator/health`));
      await page.waitForFunction(() =>
        document
          .getElementById("control-detail")
          ?.textContent?.includes("Reset failed"),
      );
      assert.equal(await page.locator("#reset").isEnabled(), true);
      fail = false;
      await page.locator("#reset").click();
      await until(
        () => demo.state.phase === "ready" && demo.state.completed === 0,
      );
      await page.locator("#step").click();
      await until(() => demo.state.completed === 1);
    } finally {
      if (javaHome === undefined) delete process.env.JAVA_HOME;
      else process.env.JAVA_HOME = javaHome;
      await browser?.close();
      await demo.close();
    }
  },
);
