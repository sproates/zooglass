# Vehicle tracker demo

A real browser receives two ZooGlass views for one vehicle: its latest position
and the history received so far. Workbench drives a twenty-position journey through the
same service and browser connections used by the app.

![Twenty received positions and the latest position 59.](docs/journey-views.png)

The route includes turns and one deliberately delayed position: 41 arrives after 42. Positions 43–59 then arrive in order.

### Short fixture

![Latest position 42 and received history 40, 42 in the browser.](docs/basic-views.png)

### Watch the demo

https://github.com/user-attachments/assets/0c43837d-2f3d-4ccf-8b22-2e5cfcf958a0

[Download the demo recording (MP4)](docs/basic-run.mp4).
The 11-second recording shows the short `--basic` fixture using real ZooGlass snapshots, with longer pauses between
positions 40 and 42 so the changes are easy to follow.

## Run it

From `incubator/workbench`, with Node 26 and Java 25 installed:

```sh
npm ci
npx playwright install chromium
npm run demo -- vehicle-tracker
```

The command compiles the app's TypeScript, starts ZooGlass and an owned Chromium
session, connects the viewer and subscribes to both views. **Step** sends one position at a time, using positions
40–59 from the [journey fixture](../workbench/scenarios/vehicle-browser-journey.json),
awaiting the HTTP and browser receipt checks after each send. The page stays
open at position 59 with twenty history entries. Add `--basic` to use the short
40/42 fixture. Ctrl+C closes the owned resources.

**Reset** cancels pending work, closes the old browser and service, and opens a
fresh session with empty views. It waits for cleanup before starting the
replacement. The window closes and reopens during reset. Step is disabled while
an action is running; Reset can interrupt it. Failed steps stop further advance.

You can also type `step`, `reset` or `quit` in the terminal. Terminal reset
remains available after the browser page closes. `--headless` uses the same
controls through the terminal without showing a window.

Add `--auto` for the previous timed demonstration. That mode plays once and
keeps the result open; it has no interactive controls. The recording above shows
this automatic mode. Play/pause, duplicate delivery and automatic recovery remain
planned. See the
[Workbench guide](../workbench/README.md#browser-host-preview) for installation
and host details.

![Step and Reset controls after completing the short fixture.](docs/step-reset.png)

## Reading the display

The current sequence and coordinates come from the `live-map` snapshot. The
history list and line come from `trip-history`. Each full snapshot replaces its
own displayed state; the app does not sort events or merge these two views into
an atomic result. Repeated history snapshots replace the list without appending
extra rows.

The SVG uses fixed bounds for this finite example: longitude -0.35 to 0.05 and
latitude 50.95 to 51.35. It is a schematic coordinate plot, not a street map.
Joining received positions does not prove the path travelled, and sequence gaps
do not establish missing data. The textual coordinates describe the same points.

The Workbench bridge sends connect/subscription instructions, never expected
vehicle data. The app owns its ZooGlass socket and renders only validated
snapshots received on that socket. Receipt observations go back to Workbench
for checks; expected results stay outside the app.

## Connection and view states

Each view distinguishes waiting for its first snapshot from receiving an explicit
empty snapshot. ZooGlass currently sends no snapshot for an uninitialised view,
so a subscription acknowledgement alone leaves that view waiting.

After disconnect or unsubscribe, previously received values remain visible and
are labelled **Last received**. Reconnecting does not make them current: each
view must receive its own fresh snapshot. A connection failure stops playback
and shows an error. In a visible demo, the failed page remains open for
inspection. Use Reset to start again, or type `reset` in the terminal if the
page or control connection is gone. Ctrl+C closes all owned resources. In
`--auto` mode, restart the command after failure; automatic headless runs clean
up on failure. Automatic reconnection is not implemented.

## Checks and current limits

From Workbench, `npm run test:browser` drives both fixtures in Chromium and checks
the visible sequence, coordinates, marker position and history at their
checkpoints, including late 41 leaving the current position at 42. It also checks that resubscription does not duplicate the history
and that the phone-width layout has no horizontal overflow. `npm run build`,
`npm run lint` and `npm run format:check` include this app.

Separate controlled protocol tests cover explicit empty snapshots, waiting,
unsubscribe, reconnect and connection failure. They do not establish service
recovery behaviour. These checks cover rendering and visible connection states. The full demo still needs
automatic recovery and independent rendered checks integrated into interactive
action completion. Lifecycle tests verify two runs separated by reset, reset
during a pending check, fresh view state, old host/service closure and reset
after page loss. The step counter reports completed service and browser receipt
checks; it does not yet certify the independently rendered result.
The local host registration is not production authorisation. See the
[demo plan](../../docs/plans/vehicle-tracker-demo.md) for the remaining behaviour.
