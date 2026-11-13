import assert from "node:assert/strict";
import test from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { startSportsBrowser } from "../../src/demos/sports/browser.js";

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
  "Sports first returning and late snapshots cover all views after three completed cycles",
  { timeout: 60000 },
  async (t) => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const demo = await startSportsBrowser({
      cycles: 3,
      tickMs: 10,
      signal: t.signal,
      async onStep(step) {
        if (
          step.cycle === 1 &&
          step.entityId === "match-1" &&
          step.name === "metadata"
        )
          await held;
      },
    });
    let browser: Browser | undefined;
    try {
      browser = await chromium.launch();
      const returning = await browser.newPage();
      await observe(returning);
      await returning.goto(demo.origin);
      await connected(returning);
      await demo.setDataBlocked(true);
      await returning.waitForFunction(() =>
        document
          .getElementById("connection")
          ?.textContent?.includes("Disconnected"),
      );
      release();
      await demo.done;
      // Let receipt-age status settle before comparing all first baselines. No
      // source is running, and a slow viewer must still receive stale metadata.
      const deadline = AbortSignal.any([t.signal, AbortSignal.timeout(20000)]);
      for (;;) {
        const snapshots = await Promise.all(
          ["match-1", "match-2", "match-3"].map(async (id) => {
            const response = await fetch(
              `${demo.baseUrl}/views/match-market/${id}`,
              { signal: deadline },
            );
            assert.equal(response.status, 200);
            return response.json();
          }),
        );
        if (
          snapshots.every(
            (snapshot) => snapshot.status.fields.market.freshness === "stale",
          )
        )
          break;
        await new Promise((resolve) => setTimeout(resolve, 50));
        deadline.throwIfAborted();
      }

      const expected = new Map<string, Record<string, unknown>>();
      for (const view of ["match-market", "scoreboard", "first-reported"])
        for (const id of ["match-1", "match-2", "match-3"]) {
          const reply = await fetch(`${demo.baseUrl}/views/${view}/${id}`, {
            signal: AbortSignal.timeout(3000),
          });
          assert.equal(reply.status, 200);
          expected.set(`${view}/${id}`, await reply.json());
        }
      await returning.evaluate("window.sportsUpdates = []");
      await demo.setDataBlocked(false);
      await connected(returning);
      const late = await browser.newPage();
      await observe(late);
      await late.goto(demo.origin);
      await connected(late);
      for (const page of [returning, late]) {
        for (const view of ["match-market", "scoreboard", "first-reported"]) {
          for (const [id, home, away, floor, observed] of [
            ["match-1", 0, 0, 28, 40],
            ["match-2", 1, 1, 24, 34],
            ["match-3", 1, 2, 26, 37],
          ] as const) {
            const first = await page.evaluate(
              `window.sportsUpdates.find(s => s.viewId === '${view}' && s.entityId === '${id}')`,
            );
            assert.ok(first, `${view}/${id} first baseline`);
            for (const part of [
              "data",
              "status",
              "provenance",
              "publicationSequences",
              "version",
            ])
              assert.deepEqual(
                first[part],
                expected.get(`${view}/${id}`)![part],
              );
            assert.equal(first.data.match.cycle, 3);
            assert.equal(first.data.match.period, "finished");
            assert.equal(first.data.match.scoreWindowStart, floor);
            assert.equal(
              first.data.homeScore,
              view === "first-reported" ? 2 : home,
            );
            assert.equal(
              first.data.awayScore,
              view === "first-reported" && id === "match-1" ? 1 : away,
            );
            assert.equal(
              first.status.fields.homeScore.facts.minimumBirthSequence,
              floor,
            );
            assert.equal(
              first.status.fields.awayScore.facts.minimumBirthSequence,
              floor,
            );
            assert.equal(
              first.status.inputs["match-feed"].observedThrough,
              observed,
            );
            assert.deepEqual(
              first.status.inputs["match-feed"].missingRanges,
              [],
            );
            assert.equal(first.publicationSequences.homeScore, undefined);
            if (view !== "scoreboard") {
              assert.deepEqual(
                first.data.homeGoals
                  .filter(
                    (f: { payload: { kind: string } }) =>
                      f.payload.kind === "goal",
                  )
                  .map(
                    (f: { payload: { scorer: string } }) => f.payload.scorer,
                  ),
                view === "first-reported"
                  ? ["Alex Vale", "Sam Reed"]
                  : id === "match-1"
                    ? []
                    : ["Taylor Brook"],
              );
              assert.ok(
                first.data.homeGoals.every(
                  (f: { birthSequence: number }) => f.birthSequence >= floor,
                ),
              );
              assert.ok(
                first.data.awayGoals.every(
                  (f: { birthSequence: number }) => f.birthSequence >= floor,
                ),
              );
            } else {
              assert.equal(first.data.market, undefined);
              assert.equal(first.data.homeGoals, undefined);
            }
            if (view === "match-market") {
              assert.equal(first.data.market.cycle, 3);
              assert.equal(first.data.market.basedOnMatchSequence, observed);
              assert.equal(first.status.fields.market.freshness, "stale");
              assert.deepEqual(first.status.inputs.bookmaker.missingRanges, [
                { from: 2, through: 2, status: "confirmed" },
              ]);
            }
          }
        }
        await displayedScore(page, "0–0");
      }
      const activity = await fetch(`${demo.origin}/activity.json`).then((r) =>
        r.json(),
      );
      assert.equal(activity.state, "complete");
      assert.equal(activity.notices.length, 20);
    } finally {
      release();
      await browser?.close();
      await demo.close();
    }
  },
);
