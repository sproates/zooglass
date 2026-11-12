# Capability delivery record

Service evidence reviewed against `7eff641` on 9 November 2026. Order demo
coverage updated against `2837dc5` on 12 November; final acceptance is proposed
in the [Order record](2026-11-12-order-acceptance.md).

ZooGlass now applies configurable reconciliation, recovery and access policies to
shared live views. This record links those behaviours to their contracts and
executable evidence. It also identifies which ones the demo collection makes
visible, so service coverage and browser presentation are easy to distinguish.

## Configuration and evidence

Each test named below contains a concrete configuration and an input sequence
with expected results. Run a selected Java test from `zooglass`, using JDK 25:

```sh
./mvnw --batch-mode -Dtest=MatchCorrectionAcceptanceTests test
```

Replace the test name with any class in the table. The wider
[test guide](../testing.md) covers boundary, invalid-input and failure cases.

| Capability | Contract and configuration | Reproducible evidence |
| --- | --- | --- |
| Different views of one source | [Field updates](../../zooglass/docs/publications.md): `arrival`, `latestBySequence`, `historyBySequence` | [SharedPublicationStrategyTests](../../zooglass/src/test/java/io/zooglass/delivery/SharedPublicationStrategyTests.java) exercises independent live subscribers. |
| Retry identity and durable recovery | [Publications](../../zooglass/docs/publications.md) and [storage](../../zooglass/docs/sqlite-storage.md): source, epoch, entity and publication sequence; `storage: "sqlite"` | [SqliteServiceRestartTests](../../zooglass/src/test/java/io/zooglass/runtime/SqliteServiceRestartTests.java) recovers snapshots and receipts. [SqliteCrashRecoveryTests](../../zooglass/src/test/java/io/zooglass/runtime/SqliteCrashRecoveryTests.java) exercises commit boundaries. |
| Different source keys for one entity | [Relationships](../design/relationships-and-conflicts.md), [configuration](../../zooglass/docs/publications.md): `lookupEntity` | [EntityMappingFunctionalTests](../../zooglass/src/test/java/io/zooglass/runtime/EntityMappingFunctionalTests.java) combines real source streams and restarts the service. |
| Conflicting source contributions | [Source priority](../design/relationships-and-conflicts.md), [configuration](../../zooglass/docs/publications.md): `inputs` and `sourcePriority` | [SourcePriorityTests](../../zooglass/src/test/java/io/zooglass/runtime/SourcePriorityTests.java) gives shared views opposite priorities. [SourcePriorityCrashTests](../../zooglass/src/test/java/io/zooglass/runtime/SourcePriorityCrashTests.java) verifies durable hidden candidates. |
| Known gaps and late events | [Progress contract](../design/progress-and-publication.md), [configuration](../../zooglass/docs/source-progress.md): `contiguousSequence`, `acceptLate`, `rejectBehindWatermark` | [ProgressAcceptanceTests](../../zooglass/src/test/java/io/zooglass/runtime/ProgressAcceptanceTests.java) distinguishes delayed, confirmed missing and untracked reports. |
| Partial inputs and reporting silence | [Publication and freshness configuration](../../zooglass/docs/source-progress.md): `requireContributions`, `receiptAge` | [ProgressCompositionTests](../../zooglass/src/test/java/io/zooglass/runtime/ProgressCompositionTests.java) combines independent progress, required fields, silence and recovery. |
| Corrections, withdrawals and totals | [Revision contract](../design/fact-revisions.md), [configuration](../../zooglass/docs/fact-collections.md): `firstFact`, `latestFactRevision`, `activeFacts`, `sumActiveFacts` | [MatchCorrectionAcceptanceTests](../../zooglass/src/test/java/io/zooglass/runtime/MatchCorrectionAcceptanceTests.java) combines two scoreboards, gaps, revisions, a crash, retries and retirement. |
| Returning and slow viewers | [Delivery contract](../design/client-delivery.md), [configuration](../../zooglass/README.md#slow-viewers): `freshSnapshot`, `disconnectOnOverflow`, `coalesceLatestState` | [ClientRecoveryAcceptanceTests](../../zooglass/src/test/java/io/zooglass/runtime/ClientRecoveryAcceptanceTests.java) covers restart in both storage modes; [SlowClientDeliveryTests](../../zooglass/src/test/java/io/zooglass/runtime/SlowClientDeliveryTests.java) provides deterministic queue coverage with mocked transports. The [Workbench concurrent-client test](../../workbench/test/concurrent-clients.test.ts) pauses a real receiver and verifies eviction while a healthy viewer continues. |
| Access that can be withdrawn | [Access contract](../design/view-access.md), [protected deployment](../../zooglass/docs/protected-deployment.md) | The [authorisation evidence map](authorisation.md) links admission, active revocation, transport release, tenant ownership and protected-client recovery to their tests. |

## What these capabilities remove from an application

Applications configure the supported policies instead of building separate
reducers, deduplication stores, revision handling and recovery logic for every
view. ZooGlass owns their runtime state, atomic installation and delivery to
subscribed consumers. The same source can serve views with different rules.

The application still supplies meaningful source identities, keys and progress
promises. It chooses the domain rules, integrates upstream systems and provides
the UI. It also owns the permission decision service and deployment operations.
See the [developer-value comparison](../developer-value.md) for concrete examples.

## Demo coverage

The [planned collection](../design/strategy-delivery.md#capability-to-demo-coverage)
remains vehicles, orders and sports. Here is what is available at this baseline:

| Experience | What it shows | Remaining coverage |
| --- | --- | --- |
| [Continuous vehicles](../../workbench/docs/continuous-driving.md) | Six cars, automatic activity, delayed/duplicate/lost reports, source interruptions and returning viewers. | Grey markers use the demo's observation-age rule. The demo does not yet expose ZooGlass receipt-age or confirmed-gap metadata. |
| [Interactive vehicles](../../demos/vehicle-tracker/README.md) | Three-car fleet and single-car fixtures; latest/history views, independent status fields, controlled faults and recovery. | Does not present durable restart or retained-fact corrections. |
| [Protected basic client](../../workbench/docs/protected-client-acceptance.md) | Real policy enforcement clears protected data on access loss and obtains a fresh authorised baseline. | An automated acceptance fixture; normal vehicle commands remain open demos. Order access-loss acceptance is now available separately. |
| [Order desk](../../demos/order-tracker/README.md) | Six orders, five independent sources and two views in continuous and interactive browsers: mappings, priority, required inputs, receipt-age freshness, progress gaps, same-store restart and protected access acceptance. | Final [acceptance and value evidence](2026-11-12-order-acceptance.md) is delivered on the shared branch. Synthetic slots, fixed mappings and separate protected fixture; no production adapters or producer-process recovery. |
| [Sports source foundation](../../workbench/docs/sports-sources.md), proposed for review | Three matches and two sources; corrected and first-reported views, derived scores, delayed facts, withdrawals, progress gaps, receipt age and bounded cycle retirement. | Source-only finite/repeating operation; live Sports browser integration and its returning-viewer experience remain pending. |

The vehicle demonstrations remain useful consumers of the shared service. They
have not been expanded to display every newly delivered strategy. Both Order
browser modes now make the listed policies visible; live Sports integration
remains planned. A service test alone is not counted as a browser experience.

The [Order acceptance record](2026-11-12-order-acceptance.md) links its separate
Chromium/Firefox/WebKit layout checks and fresh desktop/phone captures for both
commands. The following historical presentation review concerns vehicles.

## Presentation review

The delivered vehicle pages have separate purposes: the continuous page leads
with the map; the interactive fleet and basic pages expose verification controls
and received-state detail. The latter are longer pages, not the map-first showcase.

Focused checks on this baseline cover:

- Continuous six-car rendering and initial phone-width map visibility in Chromium
  and WebKit, selection, reconnect and empty-baseline clearing.
- Fleet keyboard selection and controls, 320/390/1280-pixel layouts and 200% text.
- Basic fixture keyboard controls, history scrolling and narrow-page reflow.

Run these from `workbench` after the documented installation and explicit
`npm run prepare:service` step:

```sh
npm run build:browser
node --import tsx --test --test-concurrency=1 \
  test/browser/continuous-driving.test.ts \
  test/browser/fleet-usability.test.ts \
  test/browser/usability.test.ts
```

All five focused checks passed on 9 November in about 19 seconds, after an explicit
build of the service at this baseline. Fresh continuous desktop/phone renders and
fleet/basic test screenshots were inspected. The captures used local synthetic
tiles, so this review verifies layout and markers, not a live map provider.

The continuous page keeps all six cars, navigation and attribution on the initial
phone screen. Fleet controls reflow and the basic history remains readable. One
presentation gap remains: the interactive fleet puts its map below the controls
and fleet list on a narrow screen. It does not meet the map-first showcase goal;
use continuous mode for that experience. Revisit the interactive layout alongside
its planned capability updates, rather than treating this record as a UI redesign.

These checks concern demo presentation and binding. They do not replace the
service evidence above or require formal sign-off on a physical phone.

## Boundaries

- Durable recovery is single-instance recovery. Clustering, failover and measured
  throughput/latency are separate work; this record makes no performance claim.
- A returning viewer receives current snapshots, not every missed transition.
  Independently subscribed views do not form an atomic multi-view read.
- With `contiguousSequence`, sequence jumps expose provisional gaps before any
  watermark. A scoped source watermark confirms gaps through its boundary.
  Silence alone proves neither missing events nor source failure; receipt age
  is not observation age.
- Identity, history, gaps and facts have configured bounds. Retired facts cannot
  be reconstructed, and runtime view registration has no historical backfill.
- Source priority is explicit; there is no arbitrary join or general computation
  engine. Applications still decide which source is authoritative.
- Protected serving uses the documented tenant, TLS and operator boundaries.
  Access cannot retract bytes already handed to the transport or data already
  received by a client.
