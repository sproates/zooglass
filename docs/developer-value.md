# What ZooGlass handles for your application

A live map needs more than a stream of coordinates. If report 42 arrives before
report 41, the displayed position should stay at 42. A duplicate should not change
that decision. Someone opening the map later needs the latest known position
without waiting for the next report. A viewer returning after a disconnect needs
to catch up with the service.

The [Gibraltar demo](../workbench/docs/continuous-driving.md) makes these
requirements visible with six cars. ZooGlass supplies the maintained views and
subscription snapshots. The application supplies the events and the experience
around them. This document compares those responsibilities with an equally scoped
custom service, using the current prototype rather than its intended future features.

## The work a team would otherwise own

For this comparison, the custom service only needs to match the demonstrated
in-memory behaviour. It could be a small service using ordinary maps, locks and
WebSocket libraries. A database, message broker or data warehouse is not inherently
required for this example.

| Responsibility | With an equally scoped custom service | With ZooGlass today |
| --- | --- | --- |
| Decide which input updates which field | Implement routing from source/event type to a view field, keyed by entity. | Supply a view definition. ZooGlass matches events and maintains the fields. |
| Keep the latest accepted position | Store the highest sequence and reject older or equal sequences for each field/entity. Test out-of-order and duplicate delivery. | Configure `latestBySequence`. The service applies and tests that policy centrally. |
| Combine independent contributions | Keep separate field state and ordering domains, and construct the entity's current representation. | Configure separate fields. A snapshot contains their currently accepted values. This does not establish a common observation time or completeness. |
| Serve new and returning viewers | Track subscriptions and send current state when a client subscribes. Coordinate snapshots with concurrent updates so delivery cannot regress. | Subscribe by view and entity. ZooGlass coordinates projection, subscription changes and outbound queue insertion. |
| Deliver live changes | Route updated representations to interested clients and handle disconnected or slow recipients. | ZooGlass tracks recipients and has bounded outbound queues; an overloaded client can be disconnected. |
| Display and operate the application | Build the client, reconnect logic, visual state, source integration and deployment. | The application still owns this work. ZooGlass's current WebSocket protocol does not supply a complete application client or production deployment. |

A team could implement these service behaviours itself. ZooGlass's demonstrated
value is that the projection and subscription code is shared across configured
views, with existing verification. The demo does not measure engineering time
saved or prove that adopting a separate service is worthwhile for every application.

## What the vehicle demo actually delegates

The continuous demo defines a `driving` view with `position` and `notice` fields.
Each matches its own event type from source `fleet`, and each has its own
`latestBySequence` ordering policy. See the actual
[view definition](../workbench/src/demos/vehicle/continuous/simulation.ts).

Suppose a car sends positions 40, 42 and then 41. ZooGlass retains 42 as its latest
position. Another 42 is ignored, even if its payload differs. If 43 is lost
permanently, the view cannot reconstruct it; the next accepted report might be 44.
If the car goes silent, its last accepted position remains available.

The browser renders the service's position. It does not repeat the highest-sequence
comparison locally. After reconnecting, the browser subscribes again and ZooGlass
sends the current snapshot. That is state recovery, not replay of every update the
viewer missed.

There is still substantial application work:

- The producer supplies entity IDs, meaningful increasing sequences and observation
  timestamps. It owns the synthetic routes, reporting cadence and injected faults.
- The client knows which cars to subscribe to, opens and retries its connection,
  renders markers and handles map tiles and selection.
- The client computes report age from `observedAt`. Grey markers are a demo rule,
  not ZooGlass discovering that a source is unhealthy. A new connection does not
  make an old observation current.
- Workbench starts the service and sources and hosts the demo. Its pairing and
  playback controls belong to the interactive demonstration, not ZooGlass itself.

The [browser implementation](../demos/vehicle-tracker/src/driving/app.ts) and
[report-age rule](../demos/vehicle-tracker/src/driving/report-age.ts) make that
boundary explicit. In the separate interactive fixture, location and operational
status use separate fields and sequence domains; see the
[fleet contracts](../workbench/docs/fleet-contracts.md).

## What changes when the application grows?

**Add a vehicle.** ZooGlass does not need a new projection class or view definition
for each car: the same definition is keyed by `entityId`. The application must send
that ID and subscribe to it. In this demo, adding a seventh car means adding route
geometry to `routes.json`, extending the six-element starting-offset list in
[journeys.ts](../workbench/src/demos/vehicle/continuous/journeys.ts), and
updating six-car wording and expectations. The generated `/cars.json` manifest
feeds the viewer's subscription list. There is no service-side fleet discovery API.

**Add a source.** Build the connection or adapter that emits ZooGlass events, choose
its source ID and event types, and add matching fields to the view definition.
Independent sequence counters should normally use separate fields: sources matching
one field share its ordering domain. ZooGlass does not infer how their sequences
relate or resolve their conflicting meanings. Update the client if it displays the
new contribution, and verify the intended behaviour.

**Add a view.** Define its field mappings and supported ordering policies in startup
configuration or through `POST /views`, then have clients subscribe to the new
view/entity pairs. A new runtime view starts empty and sees only subsequent events;
it is not backfilled. The same feed can support a latest-position view and a
received-history view, but `historyBySequence` grows without a retention limit.
That is why the indefinite continuous demo retains only latest values. A new
aggregation or reconciliation rule may require service code; configuration is
limited to the policies implemented today.

These examples identify concrete changes rather than promise that every extension
is configuration-only. The [service guide](../zooglass/README.md) documents
the current API and ordering rules.

## Evidence and adoption limits

The [continuous delivery checks](../workbench/test/browser/continuous-delivery.test.ts)
exercise the real service with six source sockets through repeated faults.
The [fleet recovery check](../workbench/test/browser/fleet-recovery.test.ts)
verifies snapshots after sources advance while a viewer is offline, with no later
source events to hide a missing recovery snapshot. The
[verification map](testing.md) links the wider service and client tests.

The service implementation keeps ordering policies in
[FieldUpdates](../zooglass/src/main/java/io/zooglass/FieldUpdates.java),
entity views in [ViewStore](../zooglass/src/main/java/io/zooglass/ViewStore.java),
and subscription/delivery coordination in
[LiveViewBroadcaster](../zooglass/src/main/java/io/zooglass/LiveViewBroadcaster.java).
Those are the reusable responsibilities demonstrated here.

Adopting ZooGlass also means operating a service and accepting its contracts.
State is in memory and disappears on restart. The prototype does not provide
durable recovery, correction revisions, gap detection, proof of completeness or
product authorisation. Equal-sequence conflicts are first-wins. Sources must supply
compatible event meaning and ordering, and clients still need recovery handling.

For a simple application with one feed and one screen, a small custom service may
be sufficient. The case for ZooGlass is stronger where several views or clients
would otherwise repeat this state-maintenance and subscription work. Establishing
that benefit beyond the current examples will require further integrations and
user experience, not just a larger demo.
