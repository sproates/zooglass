# ZooGlass

### Event-driven live views

Applications often need a live view built from updates owned by several
independent systems. Keeping that view useful gets harder when updates arrive
late, out of order, or are corrected, and when a client disconnects and
reconnects. ZooGlass aims to help keep those views current and make clear what
data they reflect.

ZooGlass is an early prototype. The service starter uses Java 25 and Spring
Boot. The [Scenario Simulator](incubator/workbench/README.md) uses TypeScript
and Node 26 to play JSON scenarios on a deterministic simulated timeline; it
doesn’t yet connect to the ZooGlass service or a broker.

See the [ZooGlass prototype](incubator/zooglass/README.md) and try the
[live-match scenario](incubator/workbench/scenarios/live-match.json).
