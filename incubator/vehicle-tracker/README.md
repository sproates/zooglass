# Vehicle tracker demo

A real browser receives two ZooGlass views for one vehicle: its latest position
and the history received so far. Workbench drives the basic fixture through the
same service and browser connections used by the app.

![Latest position 42 and received history 40, 42 in the browser.](docs/basic-views.png)

### Watch the demo

https://github.com/user-attachments/assets/0c43837d-2f3d-4ccf-8b22-2e5cfcf958a0

[Download the demo recording (MP4)](docs/basic-run.mp4).
The 11-second recording uses real ZooGlass snapshots, with longer pauses between
positions 40 and 42 so the changes are easy to follow.

## Run it

From `incubator/workbench`, with Node 26 and Java 25 installed:

```sh
npm ci
npx playwright install chromium
npm run demo -- vehicle-tracker
```

The command compiles the app's TypeScript, starts ZooGlass and an owned Chromium
session, connects the viewer and subscribes to both views. It sends positions
40 and 42 from the [basic fixture](../workbench/scenarios/vehicle-browser-basic.json),
awaiting the HTTP and browser receipt checks after each send. The page stays
open at position 42 with history `[40, 42]`. Ctrl+C closes the owned resources.

The current preview plays once automatically. Step/reset controls, detailed
failure states, late delivery and recovery remain planned. To run again, stop
and restart the command. `--headless` runs without a visible window. See the
[Workbench guide](../workbench/README.md#browser-host-preview) for installation
and host details.

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

## Checks and current limits

From Workbench, `npm run test:browser` drives the fixture in Chromium and checks
the visible sequence, coordinates, marker position and history at both
checkpoints. It also checks that resubscription does not duplicate the history
and that the phone-width layout has no horizontal overflow. `npm run build`,
`npm run lint` and `npm run format:check` include this app.

These checks cover the basic rendering slice. The full demo still needs
interactive lifecycle controls, repeat/reset acceptance, complete failure-state
behaviour and rendered checks integrated into interactive action completion.
The local host registration is not production authorisation. See the
[demo plan](../../docs/plans/vehicle-tracker-demo.md) for the remaining behaviour.
