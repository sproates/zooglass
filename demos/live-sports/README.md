# Live sports

A clickable presentation prototype for the [Sports design](../../docs/plans/live-sports.md).
It uses explicit local fixture snapshots: no running ZooGlass instance, real feed,
pricing engine or wagering. The visual design was accepted on 12 November 2026; live integration remains pending.

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

| File | Purpose |
| --- | --- |
| `prototype/index.html` | Landmarks, view navigation and review controls |
| `prototype/styles.css` | Match-board presentation and responsive layouts |
| `prototype/fixtures.js` | Supplied scores, goal lists and explanatory states |
| `prototype.test.mjs` | Browser regression checks against a temporary static server |
| `prototype/app.js` | Renders fixture views and handles prototype interactions |

`index.html` loads CSS and the app module; `app.js` imports fixtures. There is no
service client, fact reducer, durable storage or production playback engine here.
Live integration must consume ZooGlass snapshots and use Workbench's scenario
runner, rather than treating this fixture selector as their implementation.
