# Order sources and views

The service-side Order foundation publishes six synthetic orders through five
independent sources. ZooGlass joins their different entity keys, applies configured
field strategies and exposes two views. The [continuous Order browser](../../demos/order-tracker/README.md)
and interactive walkthrough display these views, including durable service recovery.
The [Order design](../../docs/plans/order-tracker.md) describes the complete scope.

## Run the verification

From `workbench`, after `npm ci` and `npm run prepare:service`:

```sh
npx tsx --test test/scenarios/order-simulation.test.ts test/scenarios/order-producer-lifecycle.test.ts
```

These Node-client tests use the prepared service JAR and a temporary SQLite store.
They check three cycles through HTTP, wait for real receipt-age expiry, and run
50 accelerated cycles beyond identity retention. Tests never invoke a Java build.
Separate socket tests check outages, cancellation and failure cleanup.

`startOrderSimulation()` in `src/demos/orders/simulation.ts` starts the configured
service and an infinite producer. Pass `{ cycles: 1 }` for a bounded run. Its
`baseUrl` exposes `/views/order-summary/order-1` and
`/views/order-tracking/order-1`, through `order-6`. Await `done` to observe failure;
call `close()` to release the service and its temporary database.

Each fresh run starts sequences in the `run` epoch. Restarting only the producer
against retained identities is unsupported: changed content produces
`identityConflict`, and the run fails visibly. Service restart with a continuing
producer is checked by the final interactive checkpoint.

## Configuration and responsibility

[`configuration.ts`](../src/demos/orders/configuration.ts) supplies the runtime
configuration directly. The shared service launcher passes it unchanged; it does
not translate these policies into legacy scenario declarations or implement them.

| Source          | Source entity keys            | Contribution                                  |
| --------------- | ----------------------------- | --------------------------------------------- |
| orders          | order-1 … order-6             | Order state                                   |
| payments        | payment-1 … payment-6         | Payment state                                 |
| inventory       | reservation-1 … reservation-6 | Inventory state                               |
| courier-primary | shipment-1 … shipment-6       | Authoritative delivery state                  |
| courier-backup  | tracking-1 … tracking-6       | Delivery state before the primary contributes |

Runtime lookup mappings join these keys to the six order entities. All fields use
`latestBySequence` and `acceptLate`. The summary publishes partial contributions;
tracking omits payment and waits for the first order and inventory contributions.
That gate is not an atomic transaction or a new gate for each synthetic cycle.

Delivery uses `sourcePriority`, with primary before backup. Sequence numbers from
different couriers are not compared. Inventory and delivery use a 15-second
receipt-age policy. A stale primary remains selected: freshness does not imply
failover. Reconnecting a socket does not refresh its retained value.

Orders, payments and inventory track contiguous publication sequences. Producer
watermarks confirm completeness through an explicit boundary. A missing event is
reported, not reconstructed. Couriers leave progress untracked.

The simulator owns domain statuses, timestamps, source identities and delivery
faults. ZooGlass owns reconciliation, mapping, publication gates, provenance,
progress, freshness and persistence. The browser will consume these results.
The tracking view's omission of payment is not an access-control boundary.

## Schedule

`orderTimeline()` supplies the finite first cycle; `orderStep()` generates the
same bounded schedule continuously. The default interval is three seconds:
36 ticks, or about 108 seconds per cycle. Six orders start three ticks apart.

| Relative tick | Delivery                                                                                                                                             |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0–1           | Order and payment arrive before inventory. Tracking initially waits.                                                                                 |
| 2–3           | Backup courier contributes first; primary then takes authority.                                                                                      |
| 4             | Order sequence 3 arrives ahead of sequence 2, opening a provisional gap.                                                                             |
| 5             | Delayed inventory arrives and releases tracking's required contributions.                                                                            |
| 6–7           | Order sequence 2 closes the gap without replacing sequence 3; an exact retry follows.                                                                |
| 8–9           | Payment sequences 2 and 3 arrive, except sequence 2 for order-2 is omitted once in the first cycle. Backup reports again without displacing primary. |

At global tick 24 inventory disconnects. Order-6 is cancelled at 25 and refunded
at 26 while its old reservation remains visible. Backup couriers report at 29;
the primary remains selected even when stale. Inventory reconnects at 31 and
reports at 32, including order-6's released reservation. Primary delivery reports
at 33. At 34, watermarks confirm each tracked stream's completed boundary and
order-2's missing payment revision.

Once per fresh run, tick 35 publishes `payment-unmapped`. The publication is
committed to SQLite, but its summary target rejects with `unknownEntityMapping`.
No order row changes. The rejected target has a null entity ID. Scheduled exact retries must return
`duplicate` with reason `alreadyCommitted`. The producer checks these outcomes and fails
on unexpected publication, target or watermark results.

## Repeated operation and bounds

Cycles reuse six entity slots and continue contiguous sequences for tracked
sources. Only the initial payment event is permanently lost. Repeating that loss
on every cycle would accumulate missing ranges without adding useful evidence.
A previous-cycle order retry also arrives after the next cycle has begun.

`cycle` and the order reference distinguish each slot's new synthetic order.
Contributions from the previous cycle remain until their own source updates;
the eventual UI must label that mixed state explicitly. Observation timestamps
follow the simulated clock; freshness uses ZooGlass receipt time.

The configuration bounds streams at 64, retained identities at 128 per stream,
and received/missing ranges at 64. There are 30 normal source/entity streams and
one fixed diagnostic stream. Delayed reports are reconstructed from the schedule,
not queued in a growing history. The producer owns five event sockets and one
progress socket. Completion, cancellation and failure close them all.

The 50-cycle check verifies final contributions, advancing admission floors,
absence of source-contract violations and the original gap's transition to
expired evidence. It is behavioural retention evidence, not a memory benchmark.

## Remaining delivery

The [final acceptance record](../../docs/verification/2026-11-12-order-acceptance.md)
and [developer-value comparison](../../docs/order-developer-value.md) are prepared
for review. Recovery and protected access are covered by the
[Order acceptance commands](../../demos/order-tracker/README.md). This foundation
covers the source-side scenes from Partial order through Unknown relationship
in the [design's scene table](../../docs/plans/order-tracker.md#scenes-and-expected-results).

The [continuous Order browser](../../demos/order-tracker/README.md) consumes these
views directly. Its separate notice feed reports producer steps; snapshot state
is never derived from those notices. Six product names are presentation data in
the order source payload. The service-only composition remains available for
independent source verification.

The interactive walkthrough uses `source-session.ts` for exactly the same socket
actions and receipt checks as `producer.ts`. `checkpoints.ts` supplies independent
snapshot expectations; the shared prepared-checkpoint adapter feeds the existing
playback controller. Its 18 checkpoints cover partial publication, lookup mapping,
courier priority, delayed/retried/omitted deliveries, receipt-age staleness,
reconnection, progress watermarks and the unmapped diagnostic key. Reset discards
the old database instead of replaying identities into it.

`run.ts` retains the SQLite path, source cursor and highest committed order
envelope across service generations. The final checkpoint closes the old JVM
and sockets, reopens the same store, and holds sources until `recovery.ts` checks
one real viewer's disconnect and fresh first baselines. It then requires an exact
duplicate receipt and successful next identity. `order-recovery.test.ts` checks
cancellation, isolated service failure and store cleanup; the interactive browser
test checks the full recovery path. The protected case reuses the HTTPS authority
fixture with Order-specific grants and the actual Order renderer.
