# ZooGlass

### Event-driven live views

[![ZooGlass CI](https://github.com/sproates/zooglass/actions/workflows/zooglass.yml/badge.svg?branch=main)](https://github.com/sproates/zooglass/actions/workflows/zooglass.yml)
[![Workbench CI](https://github.com/sproates/zooglass/actions/workflows/workbench.yml/badge.svg?branch=main)](https://github.com/sproates/zooglass/actions/workflows/workbench.yml)

Applications often need a live view built from updates owned by several independent systems.

Keeping that view useful gets harder when updates arrive late, out of order, are corrected, or when a client disconnects and reconnects.

ZooGlass aims to help keep event-driven views current, and clarify what data they reflect.

[What we're trying to build](docs/what-is-zooglass.md) explains the intended
product, the promises its views should make, and how Workbench will help us
verify them. Separate diagrams show ZooGlass's intended production role and the
Workbench environment used to build and test it.

ZooGlass is an early prototype with a working in-memory service and scenario
runner. The next milestone is a real browser demonstration of live views,
followed by late delivery and connection recovery.

The [roadmap and progress](ROADMAP.md) records what has landed, what's next and
which capabilities remain longer-term work, with links to the delivery evidence.

The service uses Java 25 and Spring Boot.

The [Workbench Scenario Simulator](incubator/workbench/README.md) uses TypeScript and Node 26 to play JSON scenarios on a deterministic simulated timeline. It can run those scenarios through a local ZooGlass process and check the views it produces.

See the [ZooGlass prototype](incubator/zooglass/README.md) and try the [live-match scenario](incubator/workbench/scenarios/live-match.json).

## Testing

ZooGlass has unit and functional tests for the system itself. The Workbench is
where most scenario testing should happen: it drives different event and client
behaviours through ZooGlass and checks the resulting views. Tests for
integrations with external systems, such as Kafka, are a separate concern.
