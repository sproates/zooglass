# ZooGlass

### Event-driven live views

[![ZooGlass CI](https://github.com/sproates/zooglass/actions/workflows/zooglass.yml/badge.svg?branch=main)](https://github.com/sproates/zooglass/actions/workflows/zooglass.yml)
[![Workbench CI](https://github.com/sproates/zooglass/actions/workflows/workbench.yml/badge.svg?branch=main)](https://github.com/sproates/zooglass/actions/workflows/workbench.yml)

Applications often need a live view built from updates owned by several independent systems.

Keeping that view useful gets harder when updates arrive late, out of order, are corrected, or when a client disconnects and reconnects.

ZooGlass aims to help keep event-driven views current, and clarify what data they reflect.

![ZooGlass architecture: events flow from simulated sources through ZooGlass to demo applications, with Workbench alongside generating faults and checking outcomes.](docs/diagrams/zooglass-overview.svg)

Read the stack from bottom to top. ZooGlass maintains the views; demos make them
visible. Workbench supplies scenarios and verifies the results through real service
and client interfaces. In an application deployment, your source systems and apps
fill those roles; Workbench is development and verification tooling.

[What we're trying to build](docs/what-is-zooglass.md) explains the intended
product, the promises its views should make, and how Workbench will help us
verify them. Separate diagrams show ZooGlass's intended production role and the
Workbench environment used to build and test it. The maintained
[vertical architecture diagram](docs/diagrams/README.md) explains the implemented
vehicle-demo stack and how Workbench controls and observes it.

ZooGlass is an early prototype with a working in-memory service and scenario
runner. A [basic browser demo](demos/vehicle-tracker/README.md) now shows
vehicle position and received history from real live views. Interactive controls,
late delivery, duplicate handling and bounded connection recovery are implemented.
The demo recovers current snapshots; it does not replay missed messages or
establish that received history is complete. The
[completion record](docs/verification/2026-10-27-demo-completion.md) brings together
the accepted scope and evidence for this bounded demo, delivered in
[PR #75](https://github.com/sproates/zooglass/pull/75).

The [continuous six-car Gibraltar demo](workbench/docs/continuous-driving.md):
open a map and watch ZooGlass deliver positions under delayed, lost and duplicate
reports, source reconnects and reporting silence. It runs automatically without
playback controls. It was delivered in [PR #93](https://github.com/sproates/zooglass/pull/93).

[What ZooGlass handles for your application](docs/developer-value.md) compares the
implemented service responsibilities with an equally scoped custom service, and
explains what developers still need to build.

The [roadmap](ROADMAP.md) sets out upcoming capabilities and demonstrations.

The main components live at the repository root:

- `zooglass/`: the live-view service.
- `workbench/`: scenario execution and verification.
- `demos/`: demo applications, including `demos/vehicle-tracker/`.
- `docs/`: project explanations, designs and verification records.

The service uses Java 25 and Spring Boot.

The [Workbench Scenario Simulator](workbench/README.md) uses TypeScript and Node 26 to play JSON scenarios on a deterministic simulated timeline. It can run those scenarios through a local ZooGlass process and check the views it produces.

See the [ZooGlass prototype](zooglass/README.md) and try the [live-match scenario](workbench/scenarios/live-match.json).

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
