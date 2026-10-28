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
Workbench environment used to build and test it. The maintained
[vertical architecture diagram](docs/diagrams/README.md) explains the implemented
vehicle-demo stack and how Workbench controls and observes it.

ZooGlass is an early prototype with a working in-memory service and scenario
runner. A [basic browser demo](incubator/vehicle-tracker/README.md) now shows
vehicle position and received history from real live views. Interactive controls,
late delivery, duplicate handling and bounded connection recovery are implemented.
The demo recovers current snapshots; it does not replay missed messages or
establish that received history is complete. The
[completion record](docs/verification/2026-10-27-demo-completion.md) brings together
the scope and evidence for final acceptance. Merging
[PR #75](https://github.com/sproates/zooglass/pull/75) records acceptance and closes
this bounded demo milestone.

The [continuous six-car Gibraltar demo](incubator/workbench/docs/continuous-driving.md):
open a map and watch ZooGlass deliver positions under delayed, lost and duplicate
reports, source reconnects and reporting silence. It runs automatically without
playback controls. It was delivered in [PR #93](https://github.com/sproates/zooglass/pull/93).

[What ZooGlass handles for your application](docs/developer-value.md) compares the
implemented service responsibilities with an equally scoped custom service, and
explains what developers still need to build.

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

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, checks and review expectations.
Report suspected vulnerabilities privately using [SECURITY.md](SECURITY.md).

## Licence

ZooGlass is licensed under the [MIT licence](LICENSE).
Copyright (c) 2026 Ian Sproates.
