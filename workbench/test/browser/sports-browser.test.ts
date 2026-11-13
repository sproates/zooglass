import assert from "node:assert/strict";
import test from "node:test";
import { chromium, firefox, webkit, type Browser, type Page } from "playwright";
import { startSportsBrowser } from "../../src/demos/sports/browser.js";
import { runSportsDemo } from "../../src/demos/sports/demo.js";
import { controlExchange } from "../../src/execution/control-request.js";
import type { FactRetirement } from "../../src/execution/fact-retirement.js";
import type { SportsStep } from "../../src/demos/sports/timeline.js";

/** Stops named source checkpoints; cancellation always releases the producer. */
function checkpoints(signal: AbortSignal) {
  let target = "1/match-1/metadata";
  let release = () => {};
  let arrived = () => {};
  let current = "";
  return {
    get current() {
      return current;
    },
    async onStep(step: SportsStep) {
      current = `${step.cycle}/${step.entityId}/${step.name}`;
      if (current !== target) return;
      await new Promise<void>((resolve) => {
        const resume = () => {
          signal.removeEventListener("abort", resume);
          resolve();
        };
        release = resume;
        signal.addEventListener("abort", resume, { once: true });
        arrived();
        if (signal.aborted) resume();
      });
    },
    advance(key: string) {
      return new Promise<void>((resolve) => {
        target = key;
        arrived = resolve;
        release();
      });
    },
    finish() {
      target = "";
      release();
    },
  };
}
async function observe(page: Page) {
  await page.addInitScript(
    `window.sportsUpdates = []; document.addEventListener('sports-observation', event => { if (event.detail.event === 'view-update') { window.sportsUpdates.push(event.detail); if (window.sportsUpdates.length > 100) window.sportsUpdates.shift(); } });`,
  );
}
const connected = (page: Page) =>
  page.waitForFunction(
    () =>
      document.getElementById("connection")?.textContent ===
      "Receiving live snapshots",
  );
const displayedScore = (page: Page, text: string) =>
  page.waitForFunction(
    (expected) =>
      document.querySelector("#match-detail [data-score]")?.textContent ===
      expected,
    text,
  );

test(
  "Sports browser renders source facts, freshness, first reconnect baselines and cycle boundaries",
  { timeout: 80000 },
  async () => {
    const controller = new AbortController();
    const steps = checkpoints(controller.signal);
    const demo = await startSportsBrowser({
      cycles: 2,
      tickMs: 10,
      signal: controller.signal,
      onStep: steps.onStep,
    });
    let browser: Browser | undefined;
    try {
      browser = await chromium.launch();
      const page = await browser.newPage({
        viewport: { width: 1440, height: 1100 },
      });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await observe(page);
      await page.goto(demo.origin);
      await connected(page);
      assert.equal(await page.locator("#startup").isVisible(), false);
      assert.equal(await page.locator("#playback, #fixture, #mode").count(), 0);
      assert.equal(await page.locator(".match-card").count(), 3);
      await displayedScore(page, "—–—");
      await steps.advance("1/match-1/home-baseline");
      await displayedScore(page, "—–—");
      await steps.advance("1/match-1/both-baselines");
      await displayedScore(page, "0–0");
      await steps.advance("1/match-1/corrected-scorer");
      await displayedScore(page, "2–0");
      await page.waitForFunction(() =>
        document
          .querySelector('#match-detail [data-goals="home"]')
          ?.textContent?.includes("Taylor Brook"),
      );
      assert.match(
        await page.locator('#match-detail [data-goals="home"]').innerText(),
        /Taylor Brook/,
      );
      assert.doesNotMatch(
        await page.locator('#match-detail [data-goals="home"]').innerText(),
        /baseline|Sam Reed/,
      );
      await page.locator('[data-view="comparison"]').click();
      assert.equal(
        await page.locator(".corrected .policy-score").innerText(),
        "2–0",
      );
      assert.match(await page.locator(".original").innerText(), /Sam Reed/);
      assert.match(
        await page.locator(".corrected").innerText(),
        /Taylor Brook/,
      );
      await steps.advance("1/match-1/withdrawal");
      await page.waitForFunction(
        () =>
          document.querySelector(".corrected .policy-score")?.textContent ===
          "1–0",
      );
      assert.equal(
        await page.locator(".original .policy-score").innerText(),
        "2–0",
      );
      await page.locator('[data-view="scoreboard"]').click();
      await page.waitForFunction(
        () =>
          document.querySelector('[data-match="match-1"] .team-line b')
            ?.textContent === "1",
      );
      assert.equal(await page.locator("#market").isVisible(), false);
      assert.equal(await page.locator("#match-detail").isVisible(), false);
      const boardOnly = await page.evaluate(
        `window.sportsUpdates.filter(s => s.viewId === 'scoreboard' && s.entityId === 'match-1').at(-1)`,
      );
      assert.equal(boardOnly.data.homeScore, 1);
      assert.equal(boardOnly.data.market, undefined);
      assert.equal(boardOnly.data.homeGoals, undefined);
      await page.locator('[data-view="board"]').click();
      await steps.advance("1/match-1/behind-market");
      await page.waitForFunction(
        () =>
          document.querySelector(".market-basis")?.textContent ===
          "Market references an earlier feed boundary",
      );
      await steps.advance("1/match-1/market-watermark");
      await page.waitForFunction(() =>
        document
          .querySelector("#market .gap-note")
          ?.textContent?.includes("Confirmed missing report 2"),
      );
      await steps.advance("1/match-1/bookmaker-offline");
      await page.waitForFunction(
        () =>
          document
            .querySelector(".market-state")
            ?.textContent?.includes("stale"),
        undefined,
        { timeout: 20000 },
      );
      assert.equal(
        steps.current,
        "1/match-1/bookmaker-offline",
        "freshness update came without another source event",
      );
      await steps.advance("1/match-1/bookmaker-reconnected");
      assert.match(await page.locator(".market-state").innerText(), /stale/);
      await demo.setDataBlocked(true);
      await page.waitForFunction(() =>
        document
          .getElementById("connection")
          ?.textContent?.includes("Disconnected"),
      );
      assert.equal(
        await page
          .locator(".match-card .phase")
          .filter({ hasText: "Saved snapshot" })
          .count(),
        3,
      );
      await steps.advance("1/match-3/market-refreshed");
      const expectedBaselines = new Map<string, Record<string, unknown>>();
      for (const view of ["match-market", "scoreboard", "first-reported"]) {
        for (const id of ["match-1", "match-2", "match-3"]) {
          const response = await fetch(`${demo.baseUrl}/views/${view}/${id}`);
          assert.equal(response.status, 200);
          expectedBaselines.set(`${view}/${id}`, await response.json());
        }
      }
      await page.evaluate("window.sportsUpdates = []");
      await demo.setDataBlocked(false);
      await connected(page);
      await displayedScore(page, "0–0");
      const late = await browser.newPage();
      await observe(late);
      await late.goto(demo.origin);
      await connected(late);
      for (const viewer of [page, late]) {
        for (const view of ["match-market", "scoreboard", "first-reported"]) {
          for (const [id, home, away, observed] of [
            ["match-1", 0, 0, 13],
            ["match-2", 1, 1, 11],
            ["match-3", 1, 2, 12],
          ] as const) {
            const first = await viewer.evaluate(
              `window.sportsUpdates.find(s => s.viewId === '${view}' && s.entityId === '${id}')`,
            );
            const expected = expectedBaselines.get(`${view}/${id}`)!;
            for (const part of [
              "data",
              "status",
              "provenance",
              "publicationSequences",
              "version",
            ])
              assert.deepEqual(first[part], expected[part]);
            if (view !== "scoreboard") {
              assert.deepEqual(
                first.data.homeGoals
                  .filter(
                    (goal: { payload: { kind: string } }) =>
                      goal.payload.kind === "goal",
                  )
                  .map(
                    (goal: { payload: { scorer: string } }) =>
                      goal.payload.scorer,
                  ),
                view === "first-reported"
                  ? ["Alex Vale", "Sam Reed"]
                  : id === "match-1"
                    ? []
                    : ["Taylor Brook"],
              );
            }
            assert.equal(
              first.data.homeScore,
              view === "first-reported" ? 2 : home,
            );
            assert.equal(
              first.data.awayScore,
              view === "first-reported" && id === "match-1" ? 1 : away,
            );
            assert.equal(first.data.match.cycle, 1);
            assert.equal(first.data.match.period, "finished");
            assert.equal(
              first.status.inputs["match-feed"].observedThrough,
              observed,
            );
            assert.equal(
              first.status.fields.homeScore.facts.minimumBirthSequence,
              1,
            );
            assert.equal(first.publicationSequences.homeScore, undefined);
            if (view === "match-market") {
              assert.equal(first.status.fields.market.freshness, "fresh");
              assert.deepEqual(first.status.inputs.bookmaker.missingRanges, [
                { from: 2, through: 2, status: "confirmed" },
              ]);
            }
            if (view === "scoreboard")
              assert.equal(first.data.market, undefined);
          }
        }
      }
      assert.equal(
        steps.current,
        "1/match-3/market-refreshed",
        "all first baselines observed with sources paused",
      );
      await late.close();
      await steps.advance("2/match-1/retired");
      await displayedScore(page, "—–—");
      assert.match(
        await page.locator("#match-detail").innerText(),
        /Cycle transition/,
      );
      await page.locator('[data-view="comparison"]').click();
      assert.equal(
        await page.locator(".original .policy-score").innerText(),
        "—–—",
      );
      await steps.advance("2/match-1/metadata");
      await page.locator('[data-view="board"]').click();
      await page.waitForFunction(
        () =>
          document.querySelector(".market-basis")?.textContent ===
          "Previous-cycle market · not current",
      );
      assert.deepEqual(await page.locator(".odds strong").allTextContents(), [
        "—",
        "—",
        "—",
      ]);
      assert.match(
        await page.locator("#match-detail").innerText(),
        /Awaiting score/,
      );
      await steps.advance("2/match-1/home-baseline");
      await displayedScore(page, "—–—");
      await page.locator('[data-view="scoreboard"]').click();
      assert.equal(
        await page
          .locator('[data-match="match-1"] .team-line b')
          .first()
          .innerText(),
        "—",
      );
      const boundaryLate = await browser.newPage();
      await boundaryLate.goto(demo.origin);
      await connected(boundaryLate);
      await displayedScore(boundaryLate, "—–—");
      assert.match(
        await boundaryLate.locator("#match-detail").innerText(),
        /Awaiting score/,
      );
      await steps.advance("2/match-1/both-baselines");
      await displayedScore(boundaryLate, "0–0");
      await page.waitForFunction(
        () =>
          document.querySelector('[data-match="match-1"] .team-line b')
            ?.textContent === "0",
      );
      await boundaryLate.close();
      steps.finish();
      await demo.done;
      assert.equal(
        (await fetch(`${demo.origin}/activity.json`).then((r) => r.json()))
          .notices.length,
        20,
      );
      assert.deepEqual(errors, []);
    } finally {
      controller.abort();
      await browser?.close();
      await demo.close();
    }
    await assert.rejects(
      fetch(demo.origin, { signal: AbortSignal.timeout(1000) }),
    );
    await assert.rejects(
      fetch(`${demo.baseUrl}/actuator/health`, {
        signal: AbortSignal.timeout(1000),
      }),
    );
  },
);

for (const [name, engine] of [
  ["chromium", chromium],
  ["firefox", firefox],
  ["webkit", webkit],
] as const) {
  test(
    `${name}: Sports accepted layout, keyboard selection and modern startup`,
    { timeout: 40000 },
    async () => {
      const controller = new AbortController();
      const steps = checkpoints(controller.signal);
      const demo = await startSportsBrowser({
        tickMs: 10,
        signal: controller.signal,
        onStep: steps.onStep,
      });
      let browser: Browser | undefined;
      try {
        browser = await engine.launch();
        const page = await browser.newPage({
          viewport: { width: 1440, height: 1100 },
        });
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(demo.origin);
        await connected(page);
        await steps.advance("1/match-3/withdrawal");
        await displayedScore(page, "1–0");
        await page.locator('[data-match="match-2"]').focus();
        await page.keyboard.press("Enter");
        assert.equal(
          await page
            .locator('[data-match="match-2"]')
            .getAttribute("aria-pressed"),
          "true",
        );
        assert.equal(
          await page.evaluate(
            () => (document.activeElement as HTMLElement)?.dataset.match,
          ),
          "match-2",
        );
        for (const width of [360, 390, 651, 680, 700, 768, 1440]) {
          await page.setViewportSize({ width, height: 1000 });
          for (const view of ["board", "scoreboard", "comparison"]) {
            await page.locator(`[data-view="${view}"]`).click();
            assert.equal(
              await page.evaluate(
                () => document.documentElement.scrollWidth <= innerWidth,
              ),
              true,
              `${name}/${width}/${view}`,
            );
          }
        }
        await page.setViewportSize({ width: 390, height: 844 });
        await page.locator('[data-view="board"]').click();
        await page.locator('[data-match="match-3"]').click();
        assert.equal(
          await page.evaluate(() => document.activeElement?.id),
          "match-detail",
        );
        await page.locator("#match-detail [data-back-to-matches]").click();
        assert.equal(
          await page.evaluate(
            () => (document.activeElement as HTMLElement)?.dataset.match,
          ),
          "match-3",
        );
        assert.deepEqual(errors, []);
        const unsupported = await browser.newPage();
        await unsupported.addInitScript("window.WebSocket = undefined");
        await unsupported.goto(demo.origin);
        assert.equal(await unsupported.locator("#startup").isVisible(), true);
        assert.match(
          await unsupported.locator("#startup").innerText(),
          /Chrome\/Edge 120/,
        );
        assert.equal(await unsupported.locator(".match-card").count(), 0);
        await unsupported.close();
        const broken = await browser.newPage();
        await broken.route("**/live-sports/src/app.js", (route) =>
          route.abort(),
        );
        await broken.goto(demo.origin);
        await broken.waitForFunction(() =>
          document
            .getElementById("startup")
            ?.textContent?.includes("assets could not load"),
        );
        await broken.close();
      } finally {
        controller.abort();
        await browser?.close();
        await demo.close();
      }
    },
  );
}

test(
  "Sports command keeps partial retirement failure visible until interrupted",
  { timeout: 30000 },
  async (t) => {
    const messages: string[] = [];
    t.mock.method(console, "error", (...args: unknown[]) => {
      messages.push(args.map(String).join(" "));
    });
    const initialSignals = process.listenerCount("SIGINT");
    const ready =
      Promise.withResolvers<Awaited<ReturnType<typeof startSportsBrowser>>>();
    let finished = false;
    const command = runSportsDemo(["--continuous"], async (options) => {
      const demo = await startSportsBrowser({
        ...options,
        cycles: 2,
        tickMs: 10,
        exchange(path, control) {
          const retire = control as FactRetirement;
          return exchange(
            path,
            path === "/facts/retire" && retire.viewId === "scoreboard"
              ? { ...retire, fields: ["missing"] }
              : control,
          );
        },
      });
      const exchange = controlExchange(demo.baseUrl, options.signal!);
      ready.resolve(demo);
      return demo;
    }).finally(() => {
      finished = true;
    });
    void command.catch((error) => ready.reject(error));
    const demo = await ready.promise;
    let browser: Browser | undefined;
    try {
      await assert.rejects(demo.done, /Fact retirement failed/);
      const activity = await fetch(`${demo.origin}/activity.json`).then(
        (response) => response.json(),
      );
      assert.equal(activity.state, "failed");
      assert.match(activity.error, /scoreboard/);
      for (const path of [
        "/events",
        "/facts/retire",
        "/progress",
        "/control",
        "/views/match-market/match-1",
        "/prototype/fixtures.js",
      ])
        assert.equal((await fetch(`${demo.origin}${path}`)).status, 404);
      browser = await chromium.launch({ handleSIGINT: false });
      const page = await browser.newPage();
      await page.goto(demo.origin);
      await connected(page);
      await page.waitForFunction(() =>
        document
          .getElementById("run-status")
          ?.textContent?.includes("Simulation stopped"),
      );
      await displayedScore(page, "—–—");
      assert.match(
        await page.locator("#match-detail").innerText(),
        /Cycle transition/,
      );
      await page.locator('[data-view="comparison"]').click();
      assert.deepEqual(await page.locator(".policy-score").allTextContents(), [
        "—–—",
        "—–—",
      ]);
      assert.match(
        await page.locator(".window-note").innerText(),
        /transitioning independently/,
      );
      assert.equal(await page.locator("#playback").count(), 0);
      assert.equal(
        finished,
        false,
        "failed command stays available until interrupted",
      );
      assert.match(messages.join("\n"), /Fact retirement failed/);
      process.emit("SIGINT");
      await command;
      assert.equal(process.listenerCount("SIGINT"), initialSignals);
      await assert.rejects(fetch(demo.origin));
      await assert.rejects(fetch(`${demo.baseUrl}/health`));
    } finally {
      if (!finished) process.emit("SIGINT");
      await command.catch(() => {});
      await browser?.close();
      await demo.close();
    }
  },
);
