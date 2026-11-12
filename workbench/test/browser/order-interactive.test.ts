import { WebSocket } from "ws";
import { once } from "node:events";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { chromium, firefox, webkit, type Browser } from "playwright";
import { startInteractiveOrders } from "../../src/demos/orders/interactive.js";
import { startOrderSimulation } from "../../src/demos/orders/simulation.js";
import type { OrderStep } from "../../src/demos/orders/timeline.js";

async function until(check: () => boolean, timeout = 25000) {
  const end = Date.now() + timeout;
  while (!check()) {
    assert.ok(Date.now() < end, "Timed out waiting for walkthrough state");
    await delay(20);
  }
}
function deliveries(step: OrderStep) {
  return step.actions.map((action) => {
    if (!("event" in action)) return action;
    const payload = { ...action.event.payload, observedAt: 0 };
    return { ...action, event: { ...action.event, payload } };
  });
}

test(
  "interactive controls check scenes, pause in-flight freshness, finish, and reset the stable page",
  // Four JVM starts plus real freshness expiry are included in this budget.
  { timeout: 90000 },
  async (t) => {
    const delivered: unknown[] = [];
    const demo = await startInteractiveOrders({
      signal: t.signal,
      delayBefore: 10,
      onStep: (step) => {
        delivered.push(deliveries(step));
      },
    });
    let browser: Browser | undefined;
    try {
      const foreign = new WebSocket(
        demo.origin.replace("http", "ws") + "/controls",
        { origin: "http://untrusted.invalid" },
      );
      try {
        await assert.rejects(once(foreign, "open"));
      } finally {
        foreign.terminate();
      }
      browser = await chromium.launch();
      const page = await browser.newPage({
        viewport: { width: 1440, height: 1000 },
      });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(demo.origin);
      await page.locator("#step").click();
      await page.waitForFunction(() =>
        document
          .getElementById("checkpoint-label")
          ?.textContent?.startsWith("1/18"),
      );
      await page.locator('[data-view="tracking"]').click();
      assert.match(
        await page.locator("#tracking").innerText(),
        /Waiting for tracking information/,
      );
      await page.locator('[data-view="operations"]').click();
      for (let i = 1; i < 8; i++) await demo.command("step");
      await page.waitForFunction(
        () =>
          document.querySelector('#orders [data-order="order-1"] .order-status')
            ?.textContent === "Dispatched",
      );
      const late = await browser.newPage();
      await late.goto(demo.origin);
      await late.waitForFunction(() =>
        document
          .getElementById("checkpoint-label")
          ?.textContent?.startsWith("8/18"),
      );
      await page.locator("#play").click();
      await until(
        () => demo.state.completed === 10 && demo.state.phase === "stepping",
      );
      await page.locator("#pause").click();
      await page.waitForFunction(() =>
        document
          .getElementById("control-detail")
          ?.textContent?.includes("Pausing"),
      );
      await until(
        () => demo.state.phase === "ready" && demo.state.completed === 11,
      );
      await delay(100);
      assert.equal(
        demo.state.completed,
        11,
        "Pause must not start another checkpoint",
      );
      assert.equal(demo.state.playing, false);
      await page.waitForFunction(
        () =>
          document.querySelector(
            '#orders [data-order="order-1"] [data-field="inventory"] em',
          )?.textContent === "Last known · stale",
      );
      await page.locator("#play").click();
      await until(() => demo.state.phase === "complete");
      assert.equal(demo.state.completed, 18);
      await page.waitForFunction(() =>
        document
          .getElementById("control-detail")
          ?.textContent?.includes("All steps checked"),
      );
      assert.equal(await page.locator("#step").isDisabled(), true);
      assert.equal(await page.locator("#play").isDisabled(), true);
      await page.setViewportSize({ width: 390, height: 844 });
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      );
      await page.locator('#orders [data-order="order-2"]').click();
      assert.equal(
        await page
          .getByRole("dialog", { name: "order-2 details", exact: true })
          .count(),
        1,
      );
      await page.keyboard.press("Escape");
      const oldBase = demo.baseUrl;
      await page.locator("#reset").click();
      await until(
        () => demo.state.phase === "ready" && demo.state.completed === 0,
      );
      await assert.rejects(fetch(`${oldBase}/actuator/health`));
      await page.waitForFunction(
        () =>
          document.querySelector('#orders [data-order="order-1"] .order-status')
            ?.textContent === "Not received",
      );
      await late.waitForFunction(
        () =>
          document.querySelector('#orders [data-order="order-1"] .order-status')
            ?.textContent === "Not received",
      );
      await late.close();
      assert.equal(page.url(), `${demo.origin}/`);
      for (let i = 0; i < 3; i++) await demo.command("step");
      const fresh = await fetch(
        `${demo.baseUrl}/views/order-summary/order-1`,
      ).then((r) => r.json());
      assert.equal(
        fresh.provenance.delivery.sourceId,
        "courier-backup",
        "Reset restores the fresh-run priority scene",
      );
      assert.deepEqual(errors, []);
    } finally {
      try {
        await browser?.close();
      } finally {
        await demo.close();
      }
    }
    const continuous: unknown[] = [];
    const simulation = await startOrderSimulation({
      tickMs: 10,
      cycles: 1,
      onStep: (step) => {
        continuous.push(deliveries(step));
      },
    });
    try {
      await simulation.done;
    } finally {
      await simulation.close();
    }
    assert.deepEqual(
      delivered.slice(0, 36),
      continuous,
      "Both modes deliver identical first-cycle source actions",
    );
  },
);

test(
  "Reset cancels a freshness checkpoint, clears failures and retires old callbacks",
  { timeout: 45000 },
  async (t) => {
    let fail = true;
    const demo = await startInteractiveOrders({
      signal: t.signal,
      delayBefore: 0,
      onStep: (step) => {
        if (fail && step.tick === 2)
          throw new Error("Injected source observer failure");
      },
    });
    try {
      await demo.command("step");
      await demo.command("step");
      await assert.rejects(
        demo.command("step"),
        /Injected source observer failure/,
      );
      assert.equal(demo.state.phase, "failed");
      assert.equal(demo.state.completed, 2);
      fail = false;
      await demo.command("reset");
      for (let i = 0; i < 10; i++) await demo.command("step");
      const step = demo.command("step");
      const rejected = assert.rejects(step);
      await until(() => demo.state.phase === "stepping");
      const oldBase = demo.baseUrl;
      await demo.command("reset");
      await rejected;
      assert.equal(demo.state.completed, 0);
      assert.equal(demo.state.phase, "ready");
      await assert.rejects(fetch(`${oldBase}/actuator/health`));
      await demo.command("step");
      await delay(100);
      assert.equal(demo.state.completed, 1);
    } finally {
      await demo.close();
    }
  },
);

// Each case includes a real 15-second freshness wait before reconnect. Keep
// separate budgets without repeating the same service startups or timer waits.
for (const action of ["pause", "reset"] as const) {
  test(
    `${action} during source reconnect${action === "reset" ? "; Quit during freshness" : " finishes the checkpoint"}`,
    { timeout: 50000 },
    async (t) => {
      let reached = false;
      let release = () => {};
      const demo = await startInteractiveOrders({
        signal: t.signal,
        delayBefore: 0,
        onStep: async (step, signal) => {
          if (step.tick !== 31) return;
          reached = true;
          await new Promise<void>((resolve, reject) => {
            const abort = () => reject(signal.reason);
            signal.addEventListener("abort", abort, { once: true });
            release = () => {
              signal.removeEventListener("abort", abort);
              resolve();
            };
          });
        },
      });
      try {
        await demo.command("play");
        await until(() => reached);
        if (action === "pause") {
          const pause = demo.command("pause");
          assert.equal(demo.state.phase, "stepping");
          assert.equal(demo.state.playing, false);
          release();
          await pause;
          assert.equal(demo.state.completed, 13);
        } else {
          await demo.command("reset");
          assert.equal(demo.state.completed, 0);
          assert.equal(demo.state.phase, "ready");
          // Quit during a freshness wait also retires its pending checkpoint.
          for (let i = 0; i < 10; i++) await demo.command("step");
          const step = demo.command("step");
          const rejected = assert.rejects(step);
          await demo.close();
          await rejected;
          assert.equal(demo.state.phase, "closed");
        }
      } finally {
        release();
        await demo.close();
      }
    },
  );
}

for (const engine of [firefox, webkit]) {
  test(
    `${engine.name()}: interactive controls on a phone retain the page across Reset`,
    { timeout: 40000 },
    async (t) => {
      const demo = await startInteractiveOrders({ signal: t.signal });
      let browser: Browser | undefined;
      try {
        browser = await engine.launch();
        const page = await browser.newPage({
          viewport: { width: 390, height: 844 },
        });
        await page.goto(demo.origin);
        await page.locator("#step").click();
        await page.waitForFunction(() =>
          document
            .getElementById("checkpoint-label")
            ?.textContent?.startsWith("1/18"),
        );
        await page.locator("#reset").click();
        await page.waitForFunction(
          () =>
            document
              .getElementById("checkpoint-label")
              ?.textContent?.startsWith("0/18") &&
            !(document.getElementById("step") as HTMLButtonElement).disabled,
        );
        assert.ok(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        );
        const rejection = await page.evaluate(
          () =>
            new Promise<string>((resolve, reject) => {
              const socket = new WebSocket(
                location.origin.replace("http", "ws") + "/controls",
              );
              const timer = setTimeout(() => {
                socket.close();
                reject(new Error("Control rejection timed out"));
              }, 3000);
              socket.onopen = () =>
                socket.send(JSON.stringify({ action: "step", generation: -1 }));
              socket.onmessage = (event) => {
                const message = JSON.parse(event.data);
                if (message.kind === "error") {
                  clearTimeout(timer);
                  socket.close();
                  resolve(message.detail);
                }
              };
            }),
        );
        assert.match(rejection, /replaced run/);
        assert.equal(demo.state.completed, 0);
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

test(
  "Reset startup failure stays visible and can be retried from the browser",
  { timeout: 40000 },
  async (t) => {
    const demo = await startInteractiveOrders({ signal: t.signal });
    let browser: Browser | undefined;
    const javaHome = process.env.JAVA_HOME;
    try {
      browser = await chromium.launch();
      const page = await browser.newPage();
      await page.goto(demo.origin);
      await page.locator("#step").click();
      await until(() => demo.state.completed === 1);
      try {
        // A file cannot contain bin/java: fail only the replacement JVM startup.
        process.env.JAVA_HOME = process.execPath;
        await assert.rejects(demo.command("reset"), /spawn/);
      } finally {
        if (javaHome === undefined) delete process.env.JAVA_HOME;
        else process.env.JAVA_HOME = javaHome;
      }
      assert.equal(demo.state.phase, "failed");
      await page.waitForFunction(
        () =>
          document
            .getElementById("control-detail")
            ?.textContent?.includes("Reset failed"),
        undefined,
        { timeout: 2000 },
      );
      assert.equal(await page.locator("#reset").isEnabled(), true);
      await page.locator("#reset").click();
      await page.waitForFunction(
        () =>
          document
            .getElementById("checkpoint-label")
            ?.textContent?.startsWith("0/18") &&
          !(document.getElementById("step") as HTMLButtonElement).disabled,
      );
      await page.locator("#step").click();
      await until(() => demo.state.completed === 1);
      assert.equal(page.url(), `${demo.origin}/`);
    } finally {
      if (javaHome === undefined) delete process.env.JAVA_HOME;
      else process.env.JAVA_HOME = javaHome;
      try {
        await browser?.close();
      } finally {
        await demo.close();
      }
    }
  },
);
