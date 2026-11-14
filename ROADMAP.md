# ZooGlass roadmap

Last reviewed: 14 November 2026.

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
- **Deterministic timeline simulation.** Develop Workbench from a scripted, repeatable scenario runner into a deterministic timeline simulator. Define controlled simulation time, scheduling and fault delivery so the same scenario and seed reproduce the same event ordering and outcomes within the simulated environment. Keep real-service integration runs as separate evidence; ordinary process and network timing are not deterministic today. The [execution contract and design](docs/design/deterministic-timeline.md) are now
  accepted. The separate POC has a [bounded document executor](workbench/docs/timeline-execution.md)
  with controlled Java runtime turns, causal traces and bounded verification replay.
  Bounded receipt faults and portable run bundles are implemented. The private
  [memory lifecycle executor](workbench/docs/timeline-lifecycle.md) supports
  stop/start, downtime retries and v2 replay evidence. A [60-run native memory
  qualification](workbench/docs/timeline-memory-qualification.md) verifies repeated
  restarts under long host pauses and detects an incorrect runtime receipt clock.
  [SQLite document recovery](workbench/docs/timeline-sqlite.md), read-only
  observations and fresh-store replay are implemented. [Wall-clock adjustments](workbench/docs/timeline-wall-clock.md) now exercise
  production rollback and repair behavior. A [60-run SQLite qualification](workbench/docs/timeline-sqlite-qualification.md)
  verifies three restart cases under long host pauses and detects an incorrect
  recovery clock. A [20-run fleet qualification](workbench/docs/timeline-fleet-qualification.md)
  now verifies a bounded multi-source sequence scenario, detects an incorrect
  production strategy and confirms ordinary-service parity. The [Order/Sports assessment](workbench/docs/timeline-order-sports-assessment.md)
  defines staged progress, priority and fact-retirement extensions; those profiles
  and broader fault support remain future work. The POC has not been promoted to main.
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
