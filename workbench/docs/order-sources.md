# Order sources and views

This is the service-side foundation for the planned order tracker. It publishes
six synthetic orders through three independent WebSocket sources into an unchanged
ZooGlass service. There is no order browser page or public demo command yet.
The [design](../../docs/plans/order-and-sports-demos.md) describes the subsequent
interactive and continuous browser experiences.

## Run the service verification

From `workbench`, after `npm ci` and `npm run prepare:service`:

```sh
npx tsx --test test/scenarios/order-simulation.test.ts test/scenarios/order-producer-lifecycle.test.ts
```

The tests use Node clients, not browsers. They run the real delivery schedule for
three accelerated cycles, check retained views through HTTP and obtain a late
WebSocket subscription snapshot after producers have stopped. The prepared service
JAR is reused; tests never invoke a Java build.

For composition, `startOrderSimulation()` in `src/demos/orders/simulation.ts`
starts a service configured with both views and an infinite producer. Its returned
`baseUrl` exposes `/views/order-summary/order-1` and
`/views/order-tracking/order-1`, through `order-6`. Await `done` to observe failure;
always call `close()` to release the owned service. Passing `{ cycles: 1 }` bounds
the same runner. It does not create the interactive browser experience.

## Contracts and responsibility

| Source    | Event type      | Summary field |
| --------- | --------------- | ------------- |
| orders    | order.state     | order         |
| payments  | payment.state   | payment       |
| inventory | inventory.state | inventory     |

Both view definitions are installed before publishing. `order-summary` contains
all three fields; `order-tracking` contains order and inventory only. Every field
uses `latestBySequence`. The second view is a presentation choice, not an access
control boundary. All sources explicitly supply the common order entity ID.

The simulator owns domain statuses, observation timestamps, source identity and
delivery faults. ZooGlass owns field matching, retaining accepted contributions,
sequence rejection and subscription snapshots. No browser-side join or reducer
is required. It does not infer an overall business status, detect the omitted
event or make independent contributions an atomic transaction.

## Finite checkpoints and continuous schedule

`orderTimeline()` provides 36 explicit steps, including real disconnect/reconnect
actions, for a finite first cycle. `orderStep()` supplies the same schedule for
continuous operation. The later interactive binding will use existing Workbench
controls; controls are not implemented in this slice.

The default interval is three seconds, approximately 108 seconds per cycle.
Six orders start three ticks apart. For each order, relative to its start:

| Tick | Delivery and expected observation                                              |
| ---- | ------------------------------------------------------------------------------ |
| 0    | Accepted order, initially without payment or inventory.                        |
| 1    | Payment contributes independently; order 3 is declined.                        |
| 4    | Dispatched order (order 3 cancelled), sequence 3.                              |
| 5    | Inventory observed at tick 2 arrives late, filling the missing field.          |
| 6    | Older packing report, sequence 2, arrives; the accepted order cannot regress.  |
| 7    | Exact duplicate of sequence 3; accepted facts remain unchanged.                |
| 8    | Payment revision 2 is permanently omitted.                                     |
| 9    | Payment revision 3 is published as full state. No lost event is reconstructed. |

At global tick 24 the inventory socket closes. At ticks 25 and 26 order 6 is
cancelled and refunded while inventory remains at its last accepted value. At
tick 28 a new inventory socket publishes the latest full states, including order
6's released reservation. Inventory revision 2 was not delivered during the outage.
These are deliberately compressed synthetic scenes, not real payment processing.

Cycles reuse the same six entity IDs. Sequences advance by ten per cycle;
`cycle` and the order reference identify the new synthetic order in each slot.
Contributions from the preceding cycle remain visible until their own source
updates. A viewer must label that mixed state honestly. A previous-cycle order
report also arrives after order 1's next-cycle acceptance and must be ignored.
Observation times follow the simulated clock, not server receipt time.

There is no growing event-history array or delayed queue: delayed reports are
reconstructed from the fixed schedule with their original sequence and timestamp.
Only one step's actions and three source socket references are retained. Bounded
runs close all sources; cancellation and failures also close them. The service
remains available for final snapshot inspection until its owner calls `close()`.

## Verification boundaries

Service checks use explicit expected statuses and sequences, not a production
reducer. Assertions about ignored events follow a newer observed event on the
same source socket, so a passing test cannot simply run before the ignored event
is processed. Separate transport checks prove that inventory actually reconnects
on a new socket, cancellation ends an infinite run and checkpoint failure cleans
up every source.

Browser rendering, interactive Step/Play/Pause/Reset bindings, fresh setup of both
user-facing commands and the final developer-value comparison are subsequent
slices. This foundation makes no claim about those unfinished experiences.
