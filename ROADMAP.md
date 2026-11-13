# ZooGlass roadmap

Last reviewed: 13 November 2026.

We are building configurable ways to maintain useful live views when events
arrive late, go missing, conflict or are corrected, and when services or clients
reconnect. The [capability delivery record](docs/verification/capability-delivery.md)
links the implemented policies to their configuration, tests and examples.

## Demo delivery

Fleet, Order and Sports make the runtime capabilities visible through real
service views and simulated source activity. All three have continuous and
interactive experiences.

- [Fleet](demos/vehicle-tracker/README.md): delayed, duplicated and missing position
  reports, source silence and current snapshots for returning viewers.
- [Orders](demos/order-tracker/README.md): five sources, explicit identifier mapping,
  required contributions, courier priority, progress and receipt-age freshness.
- [Sports](demos/live-sports/README.md): corrected and first-reported facts, derived
  scores, independent bookmaker updates and bounded fact retirement.

The [Order acceptance record](docs/verification/2026-11-12-order-acceptance.md) and
[Sports acceptance record](docs/verification/2026-11-13-sports-acceptance.md) collect
behavioural checks, recovery, fresh setup and desktop/phone-width evidence.
See the [cross-domain comparison](docs/sports-developer-value.md) and
[capability-to-demo mapping](docs/design/strategy-delivery.md#capability-to-demo-coverage)
for what these applications demonstrate and their limits.

## Further direction

These are planned directions, not delivered capabilities, and have no scheduled
delivery date:

- **Server-Sent Events (SSE).** Add SSE delivery for live views, with explicit snapshot, reconnect, slow-client and access behaviour consistent with the client-recovery contract.

- **New demo scenarios.** Build on vehicles, orders and sports with scenarios that show a different problem ZooGlass solves and what the application developer gains.
- **Reusable front-end components.** Investigate which parts of the demos would be useful in applications that provide their own UI.
- **Real data sources.** Investigate which independently operated sources to support first and whether their integration code would make a useful adapter.
- **Deterministic timeline simulation.** Develop Workbench from a scripted, repeatable scenario runner into a deterministic timeline simulator. Define controlled simulation time, scheduling and fault delivery so the same scenario and seed reproduce the same event ordering and outcomes within the simulated environment. Keep real-service integration runs as separate evidence; ordinary process and network timing are not deterministic today. The accepted [execution contract and design](docs/design/deterministic-timeline.md) define controlled Java runtime turns, simulated links and verification replay. A separate [bounded POC](https://github.com/sproates/zooglass/tree/poc/deterministic-timeline) covers two fixed memory-backed scenarios; general scenario support remains in development.
- **Performance measurement and optimisation.** Publish reproducible throughput, end-to-end latency and resource measurements under stated workloads, hardware and storage modes. Establish a single-instance baseline, identify bottlenecks and use the evidence to guide optimisation. Measure clustered scaling when that capability exists; current correctness tests are not throughput or latency benchmarks.
- **Clustering and high availability.** Investigate failover, distributing work across instances and client continuity. Define state ownership, replication and protection against conflicting writers, building on the existing single-instance SQLite recovery guarantees.

Broader replay, query and distributed-storage
capabilities can be considered separately as concrete needs emerge; they are not
part of the current delivery sequence.

## Background and progress

The runtime already provides entity-scoped live views, configurable reconciliation,
source progress and freshness, fact corrections, SQLite recovery and access
enforcement, delivered through HTTP snapshots and WebSocket subscriptions.
The [capability delivery record](docs/verification/capability-delivery.md) links
current contracts and evidence; Workbench exercises real interfaces. The [delivery retrospective](docs/retrospectives/2026-10-30-prototype-delivery.md)
contains the detailed history and evidence.

The [product explanation](docs/what-is-zooglass.md) describes the ambition, and the
[developer-value comparison](docs/developer-value.md) examines the application work
ZooGlass removes. Follow [open PRs](https://github.com/sproates/zooglass/pulls)
and [merged changes](https://github.com/sproates/zooglass/pulls?q=is%3Apr+is%3Amerged)
for progress, or [CI runs](https://github.com/sproates/zooglass/actions) for check results.
