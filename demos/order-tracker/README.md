# Order tracker

The [detailed design](../../docs/plans/order-tracker.md) describes the planned
ZooGlass demonstration. The current deliverable is a **clickable UI prototype**
using local fixture snapshots. It does not connect to ZooGlass or execute a
Workbench scenario. Visual acceptance is pending.

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

These are review captures, not an accepted design or live-service evidence:

- [Desktop board](docs/images/prototype-desktop.png)
- [Phone-width board](docs/images/prototype-phone.png)
- [Courier-priority phone detail](docs/images/prototype-courier.png)

Review the visual hierarchy, density, order selection, tracking view, state labels
and both control layouts. Record owner acceptance and any requested revisions
before integrating live data. The initial version was checked in Chromium and
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

| File | Responsibility |
| --- | --- |
| `prototype/index.html` | Page landmarks, view navigation and review controls |
| `prototype/styles.css` | Desktop and responsive presentation |
| `prototype/fixtures.js` | Six synthetic orders and representative display states |
| `prototype.test.mjs` | Browser regression checks against a temporary static server |
| `prototype/app.js` | Imports fixtures, renders the views and handles prototype interactions |

`index.html` loads the stylesheet and app module; `app.js` imports `fixtures.js`.
There is no event reducer, network client, persistence or production playback
engine here. Live implementation must use the accepted runtime and Workbench
contracts rather than treating these fixtures as service output code.
