# ZooGlass roadmap

Last reviewed: 28 November 2026.

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

## Configuration authoring

Optional [local configuration templates](zooglass/docs/configuration-authoring.md)
reduce repeated settings while keeping update modes explicit. Offline check, explain
and expand commands use production validation and emit ordinary runtime JSON.
Finite qualification covers complete configuration equality and real-service SQLite
restart, including rejection of an incompatible template change without losing state.

## Delivered timeline verification

- **Deterministic timeline simulation — bounded integration delivered.** The bounded
  [timeline capability](workbench/docs/timeline-guide.md) implements controlled time,
  real production runtime execution, exact replay and portable evidence. Qualified
  [memory](workbench/docs/timeline-memory-qualification.md),
  [SQLite](workbench/docs/timeline-sqlite-qualification.md),
  [Fleet](workbench/docs/timeline-fleet-qualification.md),
  [Order](workbench/docs/timeline-order-qualification.md) and
  [Sports](workbench/docs/timeline-sports-qualification.md) profiles retain their
  explicit limits. [POC acceptance checks](workbench/docs/timeline-acceptance.md)
  are complete. [PR #172](https://github.com/sproates/zooglass/pull/172) delivers
  that capability alongside the live demos with [integration qualification](workbench/docs/timeline-integration-results.md).
  The [configuration expansion](docs/design/timeline-configuration-expansion.md),
  delivered in [PR #179](https://github.com/sproates/zooglass/pull/179), adds one
  reusable memory/static-view family and five explicit legacy conversions. [Configuration admission](workbench/docs/timeline-static-admission.md) and
  [V3 conversion/execution](workbench/docs/timeline-conversion.md) are implemented
  on main, with [six authored fixtures](workbench/scenarios/timeline-static/README.md)
  and a passing [fixed qualification](workbench/docs/timeline-static-qualification.md).
  [Static-view recovery](workbench/docs/timeline-static-recovery.md), implemented
  in [PR #189](https://github.com/sproates/zooglass/pull/189), combines reusable
  configurations with memory or SQLite restart and explicit retries. Its
  [28-execution qualification](workbench/docs/timeline-recovery-qualification.md)
  passes and is delivered in [PR #190](https://github.com/sproates/zooglass/pull/190).
  Ordinary socket/browser checks and
  the [bounded completion contract](workbench/docs/timeline-completion.md) remain distinct.
- **Event explanations.** [Production publication decisions](zooglass/docs/publication-decisions.md) are delivered. The [V5 evidence and offline report](workbench/docs/timeline-explanations.md) are delivered in [PR #194](https://github.com/sproates/zooglass/pull/194). The [fixed 12-execution qualification](workbench/docs/timeline-explanation-qualification.md) passes, including a production reason mutant and independently audited retained evidence. Coverage remains the static arrival/latest/history family.

## Further direction

- **Operational logging — implementation underway.** The [logging plan](docs/design/operational-logging.md)
  defines quiet defaults, safe structured context and bounded lifecycle, storage,
  access and delivery failure records. The design is accepted; lifecycle, storage
  and processing foundations are proposed pending merge. Delivery and access
  logging remain next.
  Per-event explanations remain a separate capability.

These are planned directions, not delivered capabilities, and have no scheduled
delivery date:

- **Server-Sent Events (SSE).** Add SSE delivery for live views, with explicit snapshot, reconnect, slow-client and access behaviour consistent with the client-recovery contract.

- **New demo scenarios.** Build on vehicles, orders and sports with scenarios that show a different problem ZooGlass solves and what the application developer gains.
- **Reusable front-end components.** Investigate which parts of the demos would be useful in applications that provide their own UI.
- **Real data sources.** Investigate which independently operated sources to support first and whether their integration code would make a useful adapter.
- **Performance measurement and optimisation.** The accepted [single-instance baseline](docs/design/single-instance-performance.md) defines a finite measurement campaign before clustering work. A [scoped 100/s memory/SQLite result](workbench/docs/performance-baseline-20261125.md) is documented with raw evidence and independent audit; the [coverage report](workbench/docs/performance-coverage-20261128.md) distinguishes the finished campaign schedule from the wider matrix that remains unqualified. Further measurement should answer a concrete workload question. SQLite optimisation and alternative storage backends are separate decisions; the tested persistence configuration is not a universal ZooGlass throughput ceiling. Measure clustered scaling when that capability exists; current correctness tests are not throughput or latency benchmarks.
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
