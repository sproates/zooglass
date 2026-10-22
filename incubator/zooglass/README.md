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
- The [Scenario Simulator](../workbench/README.md) is intended to carry most
  scenario testing. It drives different event and client behaviors through
  ZooGlass and checks the resulting views.
- **Integration tests** check behavior across a boundary between ZooGlass and
  another system, such as Kafka delivering events to ZooGlass. We don't have
  these yet.
