# Live sports

Matchroom runs three fictional matches through real ZooGlass views. Both browser
modes are delivered on the shared demo delivery branch. The final
[acceptance record](../../docs/verification/2026-11-13-sports-acceptance.md) is
proposed for review; the [developer comparison](../../docs/sports-developer-value.md)
explains the work delegated and retained.
The accepted prototype remains available below as a design reference.

## Run the demo

From `workbench`, after the [documented setup](../../workbench/README.md) and
explicit preparation of `zooglass/target/zooglass.jar`:

```sh
npm run demo -- live-sports --continuous
npm run demo -- live-sports --interactive
npm run demo -- live-sports --continuous --bind=192.168.1.20
```

Use your computer's actual private IPv4 address for LAN viewing. The default is
loopback. Open the printed URL in an ordinary browser; viewers can join and leave
without affecting the sources. Ctrl+C stops the sources, host and owned service.
The command compiles browser assets but never builds Java. Each run starts a fresh
SQLite store; general producer restart and production deployment are outside scope.

Continuous mode has no playback controls and repeats the same bounded source
schedule at roughly three minutes per synthetic cycle.

Interactive mode provides 21 checked scenes using **Step**, **Play**, **Pause** and
**Reset**, below the match/detail/comparison content and above delivery notices.
Step waits for receipt and view checks. Pause allows the current check
to finish, including the real 15-second market freshness wait. The finite sequence
covers corrected and first-reported goals, missing deliveries, bookmaker outage,
and retirement into a fresh cycle. Results stay visible at completion.

Reset replaces the service and SQLite store, clears all viewers, and keeps the
same page URL. A failed checkpoint stays visible until Reset or shutdown. A failed
Reset can be retried. Viewers share the same walkthrough; commands from an old run
are rejected. Terminal commands are `step`, `play`, `pause`, `reset`, `help`/`?`
and `quit`/`q`; Ctrl+C also closes all owned resources.

If a simulation checkpoint fails, the terminal logs the error and the browser
keeps the failed run and its snapshots available for inspection. Press Ctrl+C
to close the viewer and its ZooGlass service before restarting continuous mode.
In interactive mode, Reset starts a fresh run without closing the page.

## Read the views

- **Match board:** corrected home/away goal lists and supplied scores from
  `match-market`, alongside the bookmaker's independently reported status and odds.
- **Scoreboard:** consumes `scoreboard` directly, with no market or goal fields.
- **Policy comparison:** separate `match-market` and `first-reported` subscriptions
  show how the same publications produce different results. A withdrawn goal
  disappears from corrected scores while first-reported retains its first create.

Selecting a card changes detail; phone layouts focus the detail and provide a
**Back to matches** control. Match metadata, goals and markets are synthetic.
There is no wagering, pricing engine or external sports feed.

The browser displays ZooGlass totals; it never adds goals to calculate scores.
It filters zero-point baselines out of scorer lists and checks the supplied score
window metadata. **Awaiting score** means both baselines are not yet present.
**Cycle transition** means the retained floors differ from match metadata. Only
matching floors with positive active counts on both sides establish a score,
including a genuine 0–0 after all goals have been withdrawn. Policy comparison
withholds scores while its views describe different windows; their facts remain
labelled with each view's cycle and window.

Bookmaker status, receipt-age freshness and market basis are separate. **Stale**
uses ZooGlass's 15-second receipt-age status, not a browser timer. A market can be
open yet stale or based on an earlier match boundary. A previous-cycle market's
odds are withheld. Matching progress boundaries do not prove prices are correct
or make two feeds a single transaction. Delivery gaps remain visible beside them.

On connection loss, every match is labelled as a saved snapshot. Automatic
reconnection replaces all nine view/entity snapshots, including empty state,
provenance and status-only changes. The page says it is receiving live snapshots
only after all nine first baselines arrive. Hidden pages release their socket;
returning pages subscribe afresh. Simulation notices are a separate bounded feed
(maximum 20), never an input to score calculation.

See the [source guide](../../workbench/docs/sports-sources.md), exact
[configuration](../../workbench/src/demos/sports/configuration.ts),
[consumer rules](src/model.ts) and [source map](docs/source-map.md).

## Browser support and verification

Minimum: Chrome/Edge 120, Firefox 121, Safari 17 and iOS/iPadOS 17. JavaScript
modules, WebSocket, fetch, AbortController and requestAnimationFrame are required.
Initial HTML keeps the requirements visible when startup is unsupported; supported
clients with missing assets receive a loading error instead. Use current supported
OS versions; no legacy-browser fallback or physical-device certification is claimed.

Real-service browser checks cover corrections, independent policy views, status-only
freshness expiry, previous-cycle prices, retirement/baseline labels and the first
snapshots seen by late/returning viewers while sources are paused. They also check
bounded notices, failure reporting, passive routes and owned shutdown. Separate
model tests use deliberately different supplied totals to catch client summation.

Chromium, Firefox and WebKit checks cover keyboard selection, focus return,
startup failures and all three layouts at 360, 390, 651, 680, 700, 768 and 1440px.
These captures show real service snapshots, separately from the prototype images:

- [Continuous desktop](docs/images/continuous-desktop.png)
- [Continuous phone](docs/images/continuous-phone.png)
- [Policy comparison on phone](docs/images/continuous-comparison.png)

From `workbench`, using the prepared JAR and installed Playwright browsers:

```sh
npm run build:browser
npx tsx --test test/demo-unit/sports-model.test.ts test/browser/sports-browser.test.ts
```

## Accepted static prototype

A clickable presentation prototype for the [Sports design](../../docs/plans/live-sports.md).
It uses explicit local fixture snapshots: no running ZooGlass instance, real feed,
pricing engine or wagering. The visual design was accepted on 12 November 2026. This archive remains fixture-only.

## Preview

Serve `prototype/` with a static HTTP server. With panack-http-server, from the
repository root:

```sh
panack-http-server --root demos/live-sports/prototype --host 0.0.0.0 --port 8048 --no-cache --noindex
```

Open `http://<your-LAN-IP>:8048/` on the same network. No build or dependencies.

- **Match board:** three fictional scorelines, selected match facts and a separately
  reported bookmaker market. Selecting a card changes the detail; on narrow
  screens it focuses and scrolls to the selected detail, with **Back to matches**
  returning focus to the selected card.
- **Scoreboard:** a score-only presentation with no market or goal detail.
- **Policy comparison:** corrected and first-reported scores and goal lists side
  by side. Scorer corrections and withdrawals visibly produce different results.
- **Prototype review:** choose fixture states or switch to the interactive layout.
  Step/Play/Pause/Reset move through fixed snapshots, with three seconds per Play
  step. These controls illustrate the proposed experience; they do not run the
  Workbench scenario. Continuous layout has no playback controls or automatic
  simulation in this static prototype.

Fixtures include a goal, scorer correction, withdrawal, stale market, neither/one/
both baseline facts, partial retirement failure and viewer disconnection. Displayed
scores are supplied fixture values, not sums calculated by the browser. All clocks,
relative ages and prices are illustrative. Disconnection labels every match as a
saved snapshot. The UI does not equate stale bookmaker data with a failed match.

## Visual review

Review the prominence of scores, match selection, market separation, different
revision-policy outcomes, intermediate cycle states and both control layouts.
The visual design is accepted for live integration. These captures preserve the
accepted reference; they are not runtime evidence:

- [Desktop](docs/images/prototype-desktop.png)
- [Phone width](docs/images/prototype-phone.png)
- [Policy comparison at phone width](docs/images/prototype-comparison.png)

Verified in Chromium and WebKit: selection, scoreboard isolation, divergent
revision policies, baseline gating, disconnection labels and interactive controls.
Checked all three views for horizontal overflow at 360, 390, 768, 1024 and 1440
pixels. No page errors observed. This is prototype verification, not production
browser support certification or physical-device sign-off.

## Focused prototype checks

The market stacks below the detail at widths up to 900px, including the former
651–700px overflow range. Suspended markets use amber; open markets use green.
Goal lines use domain descriptions; birth/revision identifiers are available in
**Configuration behind this view**. Selection preserves keyboard focus, and phone
detail/comparison views provide a return control.

With the Workbench dependencies and Playwright Chromium/WebKit browsers installed,
run from the repository root:

```sh
node --test demos/live-sports/prototype.test.mjs
```

These checks serve static files on loopback and launch the browsers. They do not
start or build ZooGlass. They cover the interaction regressions and changed display
states. The corrected prototype was also checked across all fixture/view combinations
at 11 widths from 360 to 1440px, including breakpoint-adjacent widths, and through
interactive completion and Reset.

## Source layout

| File                    | Purpose                                                     |
| ----------------------- | ----------------------------------------------------------- |
| `prototype/index.html`  | Landmarks, view navigation and review controls              |
| `prototype/styles.css`  | Match-board presentation and responsive layouts             |
| `prototype/fixtures.js` | Supplied scores, goal lists and explanatory states          |
| `prototype.test.mjs`    | Browser regression checks against a temporary static server |
| `prototype/app.js`      | Renders fixture views and handles prototype interactions    |

`index.html` loads CSS and the app module; `app.js` imports fixtures. There is no
service client, fact reducer, durable storage or production playback engine here.
Live integration must consume ZooGlass snapshots and use Workbench's scenario
runner, rather than treating this fixture selector as their implementation.

## Interactive verification

The real-service browser tests cover checked completion, Pause during a pending
freshness check, Reset/quit cancellation, partial retirement failure, retryable
Reset startup failure, fresh baselines in multiple viewers and identical first-cycle
source actions in both modes. The shared controls also retain Order's recovery
walkthrough. Tests use the prepared JAR and never trigger a Java build.

Interactive captures from a real service: [desktop](docs/images/interactive-desktop.png),
[phone](docs/images/interactive-phone.png), [policy comparison](docs/images/interactive-comparison.png).
