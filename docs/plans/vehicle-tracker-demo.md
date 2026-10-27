# Vehicle tracker demo

This is the delivered single-vehicle baseline. The proposed
[fleet experience](extended-vehicle-demo.md) extends it with a fuller application
and direct phone access; it does not change the acceptance scope recorded here.

Status: implemented design baseline. Merging
[PR #75](https://github.com/sproates/zooglass/pull/75) records final acceptance and
closes the bounded demo milestone.

The basic browser app
now renders short 40/42 and twenty-position journey fixtures through real
ZooGlass subscriptions, with waiting, empty and retained/error states. The journey
includes delayed 41. Step and reset now use the shared scenario session, with
fresh service/browser ownership on reset. Independent rendered checks now gate
interactive and automatic completion. Installation and keyboard/narrow-layout
verification are complete. Play/Pause now share the Step cursor, preserve remaining
delays and finish in-flight checkpoints before pausing. A separate recovery fixture now covers duplicate
processing and explicit reconnect receipts in Node and Chromium; interactive
recovery is selectable with `--recovery`, and manual viewer controls mark runs
exploratory. The host data-fault gate and bounded client recovery are implemented.
The `--fault` scenario integration is merged: it waits for a
refused retry, checks source progress during the outage, restores only the route,
and verifies the first recovery snapshots and rendering against real ZooGlass.
Node-only execution rejects the fixture before service launch. The
[recovery acceptance review](../verification/2026-10-26-recovery.md) records the
requirement-by-requirement evidence accepted in PR #69.
The [completion record](../verification/2026-10-27-demo-completion.md) brings
together the scope and evidence for that acceptance. The
[fresh-checkout walkthrough](../verification/2026-10-26-fresh-checkout.md)
verifies setup and scenario completion, accepted in PR #70. The
[cleanup review](../verification/2026-10-26-cleanup.md) records shutdown, Reset
and restart evidence, accepted in PR #71. The
[keyboard and layout review](../verification/2026-10-26-usability.md) fixes
enlarged-text overflow and records final usability evidence, accepted in PR #72.
The [capability-claims review](../verification/2026-10-27-capabilities.md)
reconciles demo labels and documentation with implementation, accepted in PR #73.
The maintained [architecture diagram guide](../diagrams/README.md) preserves the
vertical explanation beyond this plan, accepted in PR #74.

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

Run `npm run demo -- vehicle-tracker` from Workbench. After dependency
installation, it builds the browser assets, starts the session, waits for
ZooGlass health and launches an owned Chromium session through Playwright.
Node 26, JDK 25 and the documented browser installation are required.

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

## Original delivery outline

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

The original three-part outline separated session extraction from the browser
control connection and UI. Delivery used smaller PRs with separate verification
and readability work; the completion record links the accepted evidence. All
scenario client actions in this demo target the real browser. The existing Node executor remains available for headless scenarios.

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
fixture order, so the step controller completes the checks before
advancing. An empty view does not send a snapshot; subscription acknowledgements
are the barrier before source delivery. The finite trace leaves the client
connected for inspection until session cleanup.

Run the fixture through the existing Node executor from `incubator/workbench`:

```sh
npm run integrate -- --fast scenarios/vehicle-browser-basic.json
```

This verifies real ZooGlass processing and WebSocket receipt. The [host preview](../../incubator/workbench/README.md#browser-host-preview)
now launches and registers Chromium and binds `rider-app` to the browser
executor. The demo command starts ready for Step (`--basic` selects the short
fixture). Each step sends one position and awaits its following checks. Reset
restarts the service and browser with empty state; terminal controls remain
available after page loss. `--auto` retains the timed, single-run demonstration.
The browser observer must derive rendered expectations from this same fixture;
source events and expected values must never supply the app's displayed state.
The journey delivers 40, 42, delayed 41, then 43–59 in order. Position 41 is the
only deliberate gap. Duplicate delivery and recovery use the separate fixtures below. Visible
failures stop dispatch. Interactive runs can be reset from the browser or
terminal. Automatic mode retains failed headed pages for inspection and cleans
up headless failures immediately.


## Late delivery and reconnect fixture

[`vehicle-browser-recovery.json`](../../incubator/workbench/scenarios/vehicle-browser-recovery.json)
is the focused fixture for the six deliberate-action steps above. The existing
short fixture and twenty-position journey remain unchanged.

After 40 and 42, delayed 41 changes history to `[40, 41, 42]`. Only history needs
a new client receipt at that point; an HTTP check confirms that latest remains
42 after history proves processing has reached 41. The identical duplicate 41
is followed by an event for `processing-barrier` on the same source socket.
Waiting for that entity's history proves the preceding source messages have
been processed by the current service before checking unchanged vehicle state.
This uses the prototype's sequential source handling; it is not a general
cross-source ordering guarantee. No new vehicle receipt is required for a no-op.

The fixture then disconnects the viewer, sends 43 and checks both server views
before reconnecting. It subscribes to both views again and checks their initial
snapshots before any further source event can hide a stale result. The browser
receipt test runs these exact actions through the existing executor. The interactive `--recovery` mode now adds independent rendering assertions
and separate connection checkpoints. Manual viewer controls are available for
exploration. Neither mode exercises the proxy fault gate; use `--fault` for the separate
[connection-loss scenario](../../incubator/workbench/README.md#run-the-connection-loss-scenario).

### Activity and step explanation delivery

The vehicle demo now shows the current or next scripted action and retains the
latest 100 activity entries. Labels distinguish successful source sends, actual
browser view receipts, subscription acknowledgements and connection changes.
Entries are page-observation order across separate connections, not a global
causal timeline. The display never treats a send as processing confirmation.
Reset creates a new page and trace. Automatic runs have activity diagnostics;
interactive runs additionally have cursor-based step explanations.
