# Event-driven live views prototype

## Run locally

Requires JDK 25. The Maven Wrapper downloads the configured Maven version when needed.

```sh
./mvnw spring-boot:run
```

The health check is available at <http://localhost:8080/actuator/health>.

ZooGlass also accepts WebSocket connections at `ws://localhost:8080/events`.
Incoming events are matched against view definitions loaded from
`src/main/resources/views.json` at startup or added while ZooGlass is running.
A matching event replaces that field's value in the in-memory view for its
`entityId`.

For example, a client can send:

```json
{"sourceId":"match-feed","type":"score.updated","entityId":"match-42","payload":{"home":1,"away":0}}
```

The example config maps `score.updated` events from `match-feed` to the `score`
field and `odds.updated` events from `bookmaker` to the `odds` field of the
`match` view. Each field can list multiple matching source and event type pairs;
any matching event replaces that field's value. Define another view by sending
its definition to `POST /views`, for example:

```json
{
  "id": "orders",
  "fields": {
    "order": [
      { "sourceId": "order-service", "type": "order.updated" }
    ]
  }
}
```

The endpoint returns `201` when it creates the view, `400` for an invalid
definition, and `409` if that view id already exists. A newly defined view starts
empty and only receives events that arrive after its definition; ZooGlass does
not retain or replay earlier events. Query the latest representation for an
entity at `GET /views/match/match-42`. The endpoint returns JSON, or `404` if no
matching event has populated that entity in the view yet. All view data is held
in memory and is lost when ZooGlass restarts. Views created through `POST /views`
are also runtime-only; put definitions in the startup config to load them again
after a restart. The startup config can be changed with the
`zooglass.views.config` property, using a Spring resource location such as
`file:/path/to/views.json`.

For a field that needs ordering by a numeric sequence in each event payload, a
view can opt into a strategy. `latestBySequence` keeps only the event with the
highest sequence for that entity. `historyBySequence` keeps the received events
as an array in sequence order and ignores duplicate sequence numbers. For
example:

```json
{
  "id": "vehicle-live-map",
  "fields": {
    "position": [
      { "sourceId": "vehicle-feed", "type": "vehicle.location.updated" }
    ]
  },
  "ordering": {
    "position": { "mode": "latestBySequence", "sequenceField": "sequence" }
  }
}
```

Ordering is configured per view field, so the same feed can drive a latest
position view and a trip history view. The sequence must be numeric and
monotonically describe measurement order for an entity; events without a
numeric sequence are ignored by these strategies. This prototype does not wait
for missing sequence numbers, detect gaps, or know when a history is complete.
An equal numeric sequence is a duplicate even if its payload differs: the first
accepted payload is retained, not treated as a correction. Values such as `1`
and `1.0` compare equally. Sequence state belongs to each view field and entity.
If two sources match the same field, they share that sequence space; they aren't
independently deduplicated by source. Use separate fields for independent sequence
domains. This is the prototype's current behaviour, not a general conflict policy.

Trip history is held entirely in memory and grows without a bound, so it is an
exploration of the view behavior rather than a production retention policy.

For example, if sequence 40 arrives, followed by 42, the history view currently
shows `[40, 42]`. If 41 arrives later, ZooGlass inserts it into the history as
`[40, 41, 42]`. The latest-position view remains at 42. This ordering alone
does not prove that a sequence is missing: ZooGlass does not verify that a
source uses contiguous sequence values for each entity. The Workbench's
[`sequence-gap` scenario](../workbench/scenarios/sequence-gap.json) assumes
that guarantee; its
[`shared-sequence-across-entities` scenario](../workbench/scenarios/shared-sequence-across-entities.json)
shows how a shared feed can produce the same jump without an event missing from
that entity's history. See the Workbench notes on [what a sequence
guarantees](../workbench/README.md#what-a-sequence-guarantees). No policy has
been chosen for waiting on missing events or exposing an incomplete-history
status. The [source progress exploration](source-progress-signals.md) compares
signals ZooGlass might use to decide whether an event history is complete.

Clients can subscribe to a view over `ws://localhost:8080/views/live`. Send a
subscription request for a view and entity:

```json
{"action":"subscribe","viewId":"match","entityId":"match-42"}
```

ZooGlass acknowledges the subscription with a `subscribed` message. If the view
already has data, it also sends the current snapshot. Later matching events send
`view-update` messages containing the full latest snapshot. Send the same
request with `"action":"unsubscribe"` to stop receiving updates. A client
connection is removed from all subscriptions when it closes. Updates are
queued in order for each client, with up to 128 pending messages. If a client
cannot keep up and its queue fills, ZooGlass closes that connection with status
1013 rather than allowing its backlog to grow without limit.

Subscriptions belong to a WebSocket connection. After reconnecting, a client
must subscribe again; ZooGlass sends the current snapshot if one exists. It does
not replay the updates missed while the client was disconnected.

`LiveViewBroadcaster` coordinates projection, subscription changes and queue
insertion under one monitor. `SubscriptionIndex` owns both directions of
subscription membership and uses that same monitor. Each `OutboundWriter` owns
one bounded queue and writer task; socket writes and closes run outside the
coordinator monitor. A writer reports its identity on failure so a late failure
cannot remove a replacement writer. Removing a session clears its subscriptions,
cancels its writer and releases queued messages.

Run the tests with:

```sh
./mvnw test
```

## Test types

- **Unit tests** check one component in isolation. `ViewStoreTests` checks how
  event matchers update the in-memory view state.
- **Functional tests** check ZooGlass behavior as a single running system.
  `ZooGlassFunctionalTests` checks the health endpoint, and
  `ViewFunctionalTests` sends events over WebSocket and queries the view over
  HTTP.
- The [Workbench Scenario Simulator](../workbench/README.md) is intended to carry most
  scenario testing. It drives different event and client behaviors through
  ZooGlass and checks the resulting views.
- **Integration tests** check behavior across a boundary between ZooGlass and
  another system, such as Kafka delivering events to ZooGlass. We don't have
  these yet.

## Test coverage

See the [verification map](../../docs/testing.md) for coverage commands, report
boundaries and the remaining behavioural gaps.


## Projection code responsibilities

`ViewStore` owns matcher registration, entity state and the synchronised access
boundary. `ViewDefinitions` loads configuration and validates startup/runtime
definitions without owning registered state. `FieldUpdates` applies arrival,
latest-sequence and history-sequence policies to a field while the store holds
its lock; it has no independent state or lifecycle.

Startup definitions are validated before registration. Runtime definitions still
validate before checking for a duplicate ID. Ordering, first-accepted equal
sequences, changed-view notifications and defensive snapshot copies retain their
existing behaviour. Configuration and snapshot-ownership tests exercise these
boundaries through the store, alongside the independent ordering reference tests.
