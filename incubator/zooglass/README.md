# Event-driven live views prototype

## Run locally

Requires JDK 25. The Maven Wrapper downloads the configured Maven version when needed.

```sh
./mvnw spring-boot:run
```

The health check is available at <http://localhost:8080/actuator/health>.

ZooGlass also accepts WebSocket connections at `ws://localhost:8080/events`.
Incoming events are matched against the view definitions in
`src/main/resources/views.json`. A matching event replaces that field's value
in the in-memory view for its `entityId`.

For example, a client can send:

```json
{"sourceId":"match-feed","type":"score.updated","entityId":"match-42","payload":{"home":1,"away":0}}
```

The example config maps `score.updated` events from `match-feed` to the `score`
field and `odds.updated` events from `bookmaker` to the `odds` field of the
`match` view. Query the latest representation for an entity at
`GET /views/match/match-42`. The endpoint returns JSON, or `404` if no matching
event has populated that view yet. All view data is held in memory and is lost
when ZooGlass restarts. The config can be changed with the
`zooglass.views.config` property, using a Spring resource location such as
`file:/path/to/views.json`.

Run the tests with:

```sh
./mvnw test
```
