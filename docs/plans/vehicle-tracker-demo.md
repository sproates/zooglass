# Vehicle tracker demo

Status: accepted design baseline, partly implemented. The basic browser app
now renders the 40/42 fixture through real ZooGlass subscriptions. Interactive
controls, reset and late/recovery scenarios remain outstanding.

The [browser orchestration design](browser-orchestration.md) defines client
ownership, scenario actions, acknowledgements, checks and failure behaviour.
It governs the orchestration details summarised here.

## Purpose

Show what ZooGlass does for an application when vehicle positions arrive out of
order and a viewer disconnects. A reader should be able to run the demo, change
the delivery order and see the effect without reading server logs.

The central example is simple: positions 40 and 42 arrive, then 41 arrives late.
The received history becomes `[40, 41, 42]`, while the current position stays at
42. Disconnecting the viewer must leave the source running; reconnecting must
show the current ZooGlass snapshots.

This demonstrates ordering and snapshot recovery. It doesn't establish that a
history is complete or validate demand for a finished vehicle-tracking product.

## Build on Workbench

Workbench is already the scenario runner. Extend it with an interactive mode
that keeps ZooGlass and the simulated source alive while a browser is open.
Don't create a second runner or a separate implementation of scenario playback.

The current `integrate` command starts ZooGlass, runs a scenario and stops the
process. Keep that behaviour for automated checks. Extract reusable lifecycle,
source delivery and scenario-step code where needed, then use it from both the
existing command and the new interactive mode. Avoid turning this into a broad
Workbench redesign.

Proposed layout:

- `incubator/workbench`: interactive session lifecycle, control endpoints and
  simulated source, using the existing scenario format and playback ordering.
- `incubator/vehicle-tracker`: browser app, view subscription handling and
  rendering, with a short README.
- Workbench scenario fixtures: the event sequence and expected view states,
  exercised by the existing functional scenario suite.

The intended local command is `npm run demo -- vehicle-tracker` from Workbench.
This is a proposed command to implement, not one available today. After the
normal dependency installation, it should build the browser assets, start the
session, wait for ZooGlass health and print the browser URL. Keep the existing
Node 26 and JDK 25 requirements. The command will launch an owned Chromium
session through Playwright; browser installation becomes a documented setup step.

## What the user sees

Use a single vehicle and a fixed, finite route for the first version.

| Area | Behaviour |
| --- | --- |
| Route view | A local SVG plot of the received coordinates, with a distinct marker for the latest position. Label it as a schematic route, not a street map. |
| Current position | The sequence and coordinates supplied by the latest-position view. |
| Received history | Sequence-ordered positions supplied by the history view, headed “Received so far”. |
| Connection status | Connecting, subscribed/waiting for data, receiving views, disconnected or error. Retained data is visibly marked as last received while disconnected. |
| Scenario controls | Advance one step, play, pause, disconnect viewer, reconnect viewer and reset. Show the next source event and a short explanation of the selected step. |
| Activity trace | A small bounded list distinguishing source sends, view receipts and connection changes. A send is not labelled as processed. |

Use TypeScript, ordinary HTML/CSS and SVG for this bounded first version. No map
provider, tile downloads, API key or routing service is needed. Provide keyboard
controls, visible focus, readable status text and a textual equivalent of the
route. Don't rely on colour or animation to explain the result.

Connecting two received coordinates is a visual aid, not proof of the route
travelled between them. Don't show a completeness badge or infer missing events
from a sequence jump.

## Data and delivery

Use the existing `vehicle-feed` / `vehicle.location.updated` event shape with
`entityId`, `sequence`, `latitude` and `longitude`. Configure two startup views:
a `position` field using `latestBySequence`, and a `positions` field using
`historyBySequence`. Use the definitions in the
[vehicle ordering scenario](../../incubator/workbench/scenarios/vehicle-event-ordering.json)
as the reference.

Workbench sends source events through ZooGlass's `/events` WebSocket. The
browser subscribes to both views through `/views/live` and renders the `data`
from their `view-update` messages. It must not reconstruct either view from the
source trace or implement sequence reconciliation itself. Replace each view's
rendered state from its full snapshot, rather than appending every received
message to history.

Use one browser origin served by the Workbench interactive host. Proxy the live
WebSocket to the session's ZooGlass instance, with an explicit local origin
policy compatible with Spring's WebSocket checks. The proxy carries the real
protocol without synthesising view data. Test this path in a browser; a Node
WebSocket test alone doesn't exercise browser origin handling. Keep control
endpoints and servers bound to loopback for this local demo.

The two view subscriptions are independent. Their snapshots may arrive at
different times, so the UI must not claim an atomic combined snapshot. Show
waiting state separately for each view. On reconnect, open a new socket and
subscribe to both views again; use the snapshots returned by those subscriptions
rather than fetching an HTTP snapshot before subscribing. Guard against callbacks
from an old socket overwriting the new connection's state.

## Demonstration sequence

| Step | Source or viewer action | Expected result |
| --- | --- | --- |
| 1 | Connect and subscribe, then send position 40 | Current position 40; history `[40]`. |
| 2 | Send position 42 | Current position 42; history `[40, 42]`. |
| 3 | Send delayed position 41 | Current position stays 42; history becomes `[40, 41, 42]`. |
| 4 | Send position 41 again with the same payload | No duplicate history entry; current position stays 42. No new view message is required. |
| 5 | Disconnect the viewer and send position 43 | Browser retains its last received data with a disconnected label; ZooGlass advances to 43. |
| 6 | Reconnect and resubscribe | Initial snapshots show current position 43 and history `[40, 41, 42, 43]`. |

Workbench launches the browser and commands its actual connection controller
through a separate control connection. The source connection belongs to
Workbench, independently of the viewer socket.
Disconnecting the viewer must not interrupt delivery or pause the scenario.
Pause stops future scheduled actions; it doesn't cancel an event already sent.
Serialise step/play commands so repeated clicks cannot create overlapping runs.

Preserve the scenario format's ordered timeline and distinguish simulated time
from wall-clock execution. Reuse Workbench checks as processing barriers where
needed. In particular, check history contains late position 41 before asserting
that current position remains 42. Before reconnecting, check both server views
contain position 43. Sleeping or completing `socket.send()` is not evidence that
ZooGlass has processed an event.

For repeatability, Reset stops playback, closes source and viewer connections,
restarts the dedicated ZooGlass process with the demo configuration, and starts
a fresh session. Clear UI and trace state only as part of that session change;
ignore old-session messages and report reset failures. This avoids adding a
production reset endpoint or accumulating runtime view definitions. Keep the
fixture finite because history retention is currently unbounded. Stop owned
processes and sockets when the demo command exits.

## Required connection-loss run

Also demonstrate an unexpected data-path interruption. Workbench must break the
browser's real proxied ZooGlass connection, refuse reconnect attempts while the
source advances to position 43, then restore the route. The browser detects the
failure, labels retained data and automatically reconnects and resubscribes.
Verify initial snapshots and rendered state through 43 without duplicate history.
The Workbench control path remains usable throughout. This is additional to the
six deliberate-action steps above; it must not be implemented by sending the app
a disconnect command. See the [orchestration design](browser-orchestration.md)
for fault, retry, timeout and reset semantics.

## Delivery in three PRs

### PR 1: shared Workbench sessions

Extract process and connected-session ownership and the client execution boundary.
Keep existing CLI scenarios working with Node clients. Check startup failure,
repeated close and clean shutdown before introducing the browser host.

### PR 2: a working browser view

Add the browser app and the smallest Workbench interactive session needed to
serve it. Reuse process startup, health checking and source delivery. Provide
step and reset controls for positions 40 and 42, plus real subscriptions and
empty, waiting and error states. Document setup and the proposed demo command
once it exists.

Acceptance: from a fresh session, a browser displays both views after source
events pass through ZooGlass. Reset returns to an empty session and another run
works. The existing Workbench commands and scenario suite still pass.

### PR 3: late delivery and recovery

Complete the sequence and required connection-loss run above, add play/pause and independent viewer connection
controls, and add the bounded activity trace and explanations. Keep the fixture
and automated expected results together in Workbench. Cover disconnect/reconnect,
delayed processing and repeated resets through the browser path.

Acceptance: every row in the demonstration sequence and the unexpected
connection-loss recovery are observable and checked.
The late event fills in history without moving the marker backwards; reconnect
gets current snapshots while the source has continued running.

The three-PR split separates session extraction from the browser control
connection and UI. All scenario client actions in this demo target the real
browser. The existing Node executor remains available for headless scenarios.

## Verification and completion

- Keep the existing Workbench suite green, including real ZooGlass scenario runs.
- Add browser automation for initial subscriptions, late insertion, duplicate
  handling, reconnect, reset and visible connection failures. Use Playwright with Chromium for
  launch and independent rendered-state checks; pin tooling during implementation.
- Check duplicate handling after a later processing barrier, since an unchanged
  view can satisfy a check before the duplicate has reached ZooGlass.
- Test reconnect snapshots before sending another source event, so a later live
  update cannot hide a stale initial snapshot.
- Exercise source delay rather than relying on wall-clock sleeps. Check observable
  view states and session transitions.
- Manually check a desktop and narrow viewport, keyboard operation and readable
  empty/disconnected/error states. Keep rendering deterministic enough for tests.
- Confirm documented setup works from a fresh checkout, exits cleanly and can be
  restarted without stale ports or data. Include CI coverage for browser checks.

The demo is complete when someone can run the documented command, follow the
six steps and explain what ZooGlass did from the browser alone.

## Deferred work

Gap detection, watermarks, correction revisions, retention policies, durable
replay, authentication, multi-vehicle operations and external feed adapters are
separate runtime or product work. This demo should make current behaviour easier
to inspect without implying those capabilities exist. A street map and richer
visual design can follow once the interaction is useful.

## Basic scenario fixture

The [basic vehicle fixture](../../incubator/workbench/scenarios/vehicle-browser-basic.json)
contains the first two position steps. Startup definitions create `live-map`
with latest-by-sequence ordering and `trip-history` with history-by-sequence
ordering. The client starts disconnected; explicit timeline actions connect it
and subscribe to both views before the first event is sent.

Positions 40 and 42 each have HTTP checks and client receipt checks for both
views. Checks share their source event's simulation time and follow it in
fixture order, so a future step controller can complete the checks before
advancing. An empty view does not send a snapshot; subscription acknowledgements
are the barrier before source delivery. The finite trace leaves the client
connected for inspection until session cleanup.

Run the fixture through the existing Node executor from `incubator/workbench`:

```sh
npm run integrate -- --fast scenarios/vehicle-browser-basic.json
```

This verifies real ZooGlass processing and WebSocket receipt. The [host preview](../../incubator/workbench/README.md#browser-host-preview)
now launches and registers Chromium and binds `rider-app` to the browser
executor. The demo command plays this basic fixture once and keeps the received
result open for inspection. Interactive step/reset controls remain planned.
The browser observer must derive rendered expectations from this same fixture;
source events and expected values must never supply the app's displayed state.
Late events, duplicate delivery and recovery will extend the demo in later work.
