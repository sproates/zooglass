# ZooGlass roadmap

Last reviewed: 12 November 2026.

We are building configurable ways to maintain useful live views when events
arrive late, go missing, conflict or are corrected, and when services or clients
reconnect. The [capability delivery record](docs/verification/capability-delivery.md)
links the implemented policies to their configuration, tests and examples.

## Next: order tracking, then sports

The next demonstrations make the capabilities visible in familiar multi-source
applications:

- **Order tracking:** combine order, payment and inventory facts into useful
  views despite missing inputs and independently progressing sources.
- **Live sports:** combine match and bookmaker publications, including corrections
  and different update rates.

Each will have an interactive scenario and a continuously running mode. Together
they should show what ZooGlass makes easier and which domain rules still belong
in the application. The order-source foundation is already available; the browser
experiences follow the service capabilities they demonstrate.

See the [demo design](docs/plans/order-and-sports-demos.md) and
[capability-to-demo mapping](docs/design/strategy-delivery.md#capability-to-demo-coverage).

## Further direction

These are planned directions, not delivered capabilities, and have no scheduled
delivery date:

- **Server-Sent Events (SSE).** Add SSE delivery for live views, with explicit snapshot, reconnect, slow-client and access behaviour consistent with the client-recovery contract.

- **New demo scenarios.** Build on vehicles, orders and sports with scenarios that show a different problem ZooGlass solves and what the application developer gains.
- **Reusable front-end components.** Investigate which parts of the demos would be useful in applications that provide their own UI.
- **Real data sources.** Investigate which independently operated sources to support first and whether their integration code would make a useful adapter.
- **Deterministic timeline simulation.** Develop Workbench from a scripted, repeatable scenario runner into a deterministic timeline simulator. Define controlled simulation time, scheduling and fault delivery so the same scenario and seed reproduce the same event ordering and outcomes within the simulated environment. Keep real-service integration runs as separate evidence; ordinary process and network timing are not deterministic today. The execution contract and design come first.
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
