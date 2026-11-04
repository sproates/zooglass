# ZooGlass roadmap

Last reviewed: 5 November 2026.

We are building configurable ways to maintain useful live views when events
arrive late, go missing, conflict or are corrected, and when services or clients
reconnect. The next phase turns those behaviours into explicit strategy modules
and demonstrates the application work they remove.

## Next: corrections and retractions

View-local mappings and source-priority selection are delivered. ZooGlass retains
independent source candidates, preserves hidden updates across restart and selects
winners without comparing unrelated sequence numbers. See the
[relationship design](docs/design/relationships-and-conflicts.md).

The accepted [design](docs/design/progress-and-publication.md) explains how
configuration selects source-progress, late-event, receipt-age and publication
policies. Source progress, bounded gaps, per-field late decisions and durable
watermark outcomes are implemented. Views can now wait for required fields before
exposing their values. Fields can also classify the age of their last accepted
contribution and become stale during silence. Combined acceptance checks cover
late and missing reports, shared feeds, independent source progress and silence
alongside required-field publication. See the [verification guide](docs/testing.md#progress-and-late-policy).
Timeouts do not prove completeness, and staleness does not automatically change
source priority.

The proposed [revision design](docs/design/fact-revisions.md) defines how to
correct or retract retained facts, retire them explicitly and update bounded
derived values when those facts change.

Arrival, latest-by-sequence and history-by-sequence already have named strategy
modules selected by configuration. The [v2 memory API](zooglass/docs/v2-ingestion.md)
adds explicit publication identities and retry outcomes. Optional
[SQLite storage](zooglass/docs/sqlite-storage.md) now restores these identities and
views after restart. Automated process-crash checks cover partial writes and
commit/acknowledgement boundaries.

The [accepted strategy design](docs/design/strategy-modules.md) sets out the
module responsibilities. The [behaviour contracts](docs/design/behaviour-contracts.md)
and [delivery plan](docs/design/strategy-delivery.md) describe the subsequent work.

## Build out the capabilities

The delivery sequence brings persistence forward so later strategies build on
clear state ownership and recovery rules:

1. **Identity and durable state:** explicit source identity, transactional updates
   and recovery after a ZooGlass restart, using a single-instance SQLite store.
2. **Relationships and conflicts:** map contributions to the same entity and
   configure how independent sources are combined or prioritised.
3. **Progress and freshness:** expose known gaps, reporting age and partial inputs,
   with explicit choices for late events and publication.
4. **Corrections:** revise or retract retained facts and update bounded derived
   values when those facts change.
5. **Client recovery and queues:** define fresh-snapshot recovery and bounded
   delivery policies for slow or disconnected consumers.

Each capability includes its configuration, runtime strategy, behavioural tests
and documentation. The delivery plan breaks these areas into focused PRs.

## Demonstrate the value: orders, then sports

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

## Authorisation over time

After the planned demonstrations, implement permissions across snapshots, live
subscriptions and recovery. Revocation and expiry must stop active delivery
within a defined bound, and reconnecting must not bypass a permission change.

The [authorisation requirement](docs/requirements/authorisation.md) covers resource
and tenant boundaries. Its design will settle identity and policy integration,
revocation bounds, queued data and unavailable policy decisions.

## Further direction

These items have no scheduled delivery date:

- **Server-Sent Events (SSE).** Add SSE delivery for live views, with explicit snapshot, reconnect, slow-client and access behaviour consistent with the client-recovery contract.

- **New demo scenarios.** Build on vehicles, orders and sports with scenarios that show a different problem ZooGlass solves and what the application developer gains.
- **Reusable front-end components.** Investigate which parts of the demos would be useful in applications that provide their own UI.
- **Real data sources.** Investigate which independently operated sources to support first and whether their integration code would make a useful adapter.
- **Clustering and high availability.** Investigate failover, distributing work across instances and client continuity. Define state ownership, replication and protection against conflicting writers, building on the existing single-instance SQLite recovery guarantees.

Broader replay, query and distributed-storage
capabilities can be considered separately as concrete needs emerge; they are not
part of the current delivery sequence.

## Background and progress

The prototype already provides entity-scoped live views, configurable field
ordering, HTTP snapshots and WebSocket subscriptions, with Workbench scenarios
for verification. The [delivery retrospective](docs/retrospectives/2026-10-30-prototype-delivery.md)
contains the detailed history and evidence.

The [product explanation](docs/what-is-zooglass.md) describes the ambition, and the
[developer-value comparison](docs/developer-value.md) examines the work the
prototype removes. Follow [open PRs](https://github.com/sproates/zooglass/pulls)
and [merged changes](https://github.com/sproates/zooglass/pulls?q=is%3Apr+is%3Amerged)
for progress, or [CI runs](https://github.com/sproates/zooglass/actions) for check results.
