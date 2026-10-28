# Continuous Gibraltar fleet

Run `npm run prepare:service` once after changing ZooGlass, then
`npm run demo:drive -- --bind=<private IPv4 address>` from `incubator/workbench`.
Without `--bind`, the viewer is local to the Mac. Open the printed URL in any
browser. No pairing or playback controls are needed. Ctrl+C stops the run.

Six synthetic cars follow closed road polylines automatically. Each publishes
positions to ZooGlass; the browser subscribes to the latest-position view.
Closing a browser does not stop the sources. Each lap retains increasing sequence
numbers. The viewer does not receive the simulator's intended coordinates.

Road geometry is derived from OpenStreetMap, retrieved 28 October 2026, under
[ODbL](https://www.openstreetmap.org/copyright). `routes.json` retains source way
IDs and attribution. Routes follow mapped one-way directions, avoid Main Street,
and are illustrative journeys rather than a turn-restriction-validated router.
Speeds are approximately 18–25 km/h. The map uses the existing configurable tile
provider; tests use local synthetic tiles. Six latest positions are retained;
this demo does not define an indefinitely growing history view.

The existing interactive scenario fixtures remain separate development tools.

## Imperfect delivery

Each car repeats a staggered 180-report schedule: one report is held for five
report intervals, one is duplicated exactly, one is dropped forever, the source
socket closes for twenty reports, and later the connected source goes silent for
twenty reports. Cars continue along their journeys during these gaps. Reconnecting
sends new observations, not a replay of lost reports. Other cars continue reporting.
The default cadence is one report per second. No fault depends on browser presence.

ZooGlass retains the highest accepted sequence for each car. An older or equal
sequence cannot replace it; equal-sequence conflicts are first-wins, not corrections.
Permanent loss is not repaired. A grey, dashed marker means its observation is at
least eight seconds old, the viewer is disconnected, or it is awaiting a new
subscription snapshot. Reconnection does not change the observation timestamp.
These are demo age labels, not a ZooGlass source-health or physical-location guarantee.
The host and viewer clocks should be synchronised for meaningful age labels.

The brief footer notices are labelled Simulator: they describe injected delivery
conditions, not ZooGlass acknowledgements. Notices are also projected through
ZooGlass, independently of position, so they cannot refresh an old position's age.
Only the latest position and notice per car are stored. At most one delayed report
per car is queued; no growing event history or browser activity list is maintained.
ZooGlass state remains in memory and is lost when the application stops.
