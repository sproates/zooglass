# Order tracker

The continuous and interactive demos display six synthetic orders through real ZooGlass views.
The operations board and tracking presentation use the accepted visual design;
source selection, progress, readiness and freshness come from the service.
The [detailed design](../../docs/plans/order-tracker.md) also specifies the later
service-recovery and protected-access slices, which remain future work.

## Run the live demo

From `workbench/`, install dependencies with `npm ci`. Prepare ZooGlass once with
`npm run prepare:service` if a current `zooglass/target/zooglass.jar` is not already
available. Preparation is explicit; the demo and its tests never build the service.

```sh
npm run demo -- order-tracker --continuous
npm run demo -- order-tracker --interactive
# Optional access on your private LAN:
npm run demo -- order-tracker --continuous --bind=<private IPv4>
```

Open the printed ordinary URL. Multiple and late viewers each receive their own
current snapshots. Closing all viewers leaves the producer running. Ctrl+C closes
the host, sockets, service and run-owned temporary SQLite store. The six slots
repeat roughly every 108 seconds.

Select a row for its source details (a named dialog on phones), or switch to the
smaller Tracking view. Tracking subscribes directly to `order-tracking`; it does
not filter or derive the operations view. Payment is absent by definition, not
hidden by an authorisation boundary.

- **Not received** is unknown, not failure. Tracking waits for initial order and
  stock contributions; it does not wait for payment approval.
- **Last known · stale** comes from receipt-age status. A stale primary courier
  stays selected; silence does not choose the backup or prove disconnection.
- **Source delivery gap** has provisional/confirmed/expired ranges in the source
  disclosure. Newer values do not repair missing reports.
- **Previous cycle** marks retained contributions from a reused slot. A new order
  is not atomically combined with new payment/stock/delivery values.
- A disconnected viewer retains labelled saved snapshots, retries automatically,
  and replaces each pair with its first fresh baseline, including empty data.
- **Simulated delivery events** is a separate bounded Workbench notice feed.
  It cannot determine the view's values or status.

## Interactive walkthrough

Interactive mode starts with empty views and 17 checked checkpoints. Controls sit
below the board, as in the accepted prototype. Step sends the next scene and waits
for independent checks against the real service. Play advances automatically;
Pause stops future checkpoints while the current action finishes. The freshness
scene may take about 15 seconds; the page shows that the check is still running.
The final result remains visible with Step and Play disabled.

Reset keeps the URL and page open, clears the old snapshots and starts a new
service, SQLite store and source identities. The backup-first courier and missing
payment scenes therefore repeat faithfully. Reset and Quit cancel pending waits
and await cleanup; a failed check is shown and does not advance the cursor.

Use the page buttons or terminal `step`, `play`, `pause`, `reset`, `help` and `quit`
(`q` also quits). All viewers share the same walkthrough controls. This is a
trusted local/private-LAN demo, not an authenticated control service. Continuous
mode exposes no control channel or playback buttons. Both modes execute the same
source deliveries and use the same snapshot rendering. Service restart against a
retained database and protected access are separate future scenes.

## Browser baseline and verification

Use Chrome/Edge 120+, Firefox 121+ or Safari 17+; iPhone/iPad require iOS/iPadOS 17+.
Desktop and Android devices must run an OS supported by that browser version.
Required capabilities are JavaScript modules, native dialogs, WebSocket, Fetch,
AbortController and animation-frame scheduling. Below the browser baseline or
with missing capabilities, the initial HTML explains the requirements and does
not start the app. Asset/network failures have a separate reload message.

Chromium, Firefox and WebKit automated checks cover desktop/phone layouts, selection,
dialog focus, startup gating and asset failure. Real-service checks cover waiting,
status-only freshness, source provenance, sequences, gaps, multiple/late viewers
and first reconnect snapshots while publication is paused. Browser engine testing
is not physical-device qualification or proof on every historical minimum version.

```sh
# From workbench; use the prepared JAR:
npm run build:browser
npx tsx --test test/browser/order-browser.test.ts test/browser/order-interactive.test.ts
```

See the [browser source map](docs/source-map.md), [source schedule](../../workbench/docs/order-sources.md)
and live [desktop](docs/images/continuous-desktop.png) / [phone](docs/images/continuous-phone.png) captures. Interactive [desktop](docs/images/interactive-desktop.png) and
[phone](docs/images/interactive-phone.png) captures show the compact controls.

## Accepted static reference

The clickable prototype uses local fixture snapshots and does not connect to
ZooGlass. Its visual design was accepted on 12 November 2026. Keep it as a
reference when extending the live presentation.

## Preview the prototype

Serve `prototype/` with a static HTTP server. For example, with
[panack-http-server](https://github.com/sproates/panackelty/tree/main/tools/http-server):

```sh
panack-http-server --root demos/order-tracker/prototype --host 0.0.0.0 --port 8047 --no-cache --noindex
```

Run this from the repository root, then open `http://<your-LAN-IP>:8047/` from a
browser on the same network. No build, dependencies or service preparation needed.

- Select any of the six orders. Desktop shows a detail panel; narrow screens open
  a dismissible detail dialog.
- Switch to **Tracking view** to see the smaller view without payment data.
- Open **Prototype review** below the board to change the selected order's state
  or switch between continuous and interactive layouts.
- Interactive controls advance a fixed list of fixture snapshots. Play changes
  the fixture every three seconds; Pause stops it; Reset returns to the first
  checkpoint. These illustrate the controls, not the real scenario timeline.

The continuous layout is a static fixture preview with no playback controls.
Waiting, stale stock, missing payment delivery and mixed cycles are represented
on the initial board. The disconnected fixture marks all rows as saved snapshots;
it represents the unprotected synthetic demo, not protected access behaviour.
The **Stale primary courier** fixture shows selected primary and unselected backup
reports with their own ages. The stale primary stays authoritative despite a fresh
backup; the same fixture appears in the interactive walkthrough. Mixed-cycle detail
labels each retained payment, stock and delivery value. All relative ages are
illustrative labels, not ticking runtime timestamps.

## Layout and review

The operations board keeps payment, stock and delivery together, with selected
order details beside it. On narrow screens, compact rows remain the primary
content. The tracking view withholds values while required contributions are
missing. Explanations and source rules are secondary disclosures.

These captures preserve the accepted visual reference; they are not live-service evidence:

- [Desktop board](docs/images/prototype-desktop.png)
- [Phone-width board](docs/images/prototype-phone.png)
- [Courier-priority phone detail](docs/images/prototype-courier.png)

Review the visual hierarchy, density, order selection, tracking view, state labels
and both control layouts when extending the accepted reference. The initial
version was checked in Chromium and
WebKit, including selection/dialogs, tracking withholding, mixed/disconnected
states, control interactions and overflow at widths 360, 390, 768, 1024 and 1440.
This is not device qualification or a production browser support declaration.

## Focused prototype checks

Selection preserves keyboard focus in both views. The phone dialog is named for
the selected order and returns focus on Close or Escape. Critical phone field and
state labels are at least 12px.

With the Workbench dependencies and Playwright Chromium/WebKit browsers installed,
run from the repository root:

```sh
node --test demos/order-tracker/prototype.test.mjs
```

These checks serve static files on loopback and launch the browsers. They do not
start or build ZooGlass. They cover the interaction regressions and changed display
states. The corrected prototype was also checked across all fixture/view combinations
at 11 widths from 360 to 1440px, including breakpoint-adjacent widths, and through
interactive completion and Reset.

## Source layout

| File                    | Responsibility                                                         |
| ----------------------- | ---------------------------------------------------------------------- |
| `prototype/index.html`  | Page landmarks, view navigation and review controls                    |
| `prototype/styles.css`  | Desktop and responsive presentation                                    |
| `prototype/fixtures.js` | Six synthetic orders and representative display states                 |
| `prototype.test.mjs`    | Browser regression checks against a temporary static server            |
| `prototype/app.js`      | Imports fixtures, renders the views and handles prototype interactions |

`index.html` loads the stylesheet and app module; `app.js` imports `fixtures.js`.
There is no event reducer, network client, persistence or production playback
engine here. Live implementation must use the accepted runtime and Workbench
contracts rather than treating these fixtures as service output code.
