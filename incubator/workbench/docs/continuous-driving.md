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
