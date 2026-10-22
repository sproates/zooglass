# Event-driven live views prototype

## Run locally

Requires JDK 25. The Maven Wrapper downloads the configured Maven version when needed.

```sh
./mvnw spring-boot:run
```

The health check is available at <http://localhost:8080/actuator/health>.

ZooGlass also accepts WebSocket connections at `ws://localhost:8080/events`.
Text messages sent by a client are written to the application log. The service
doesn't validate, store, transform, or forward them yet.

For example, a client can send:

```json
{"sourceId":"match-feed","type":"score.updated","entityId":"match-42","payload":{"home":1,"away":0}}
```

Run the tests with:

```sh
./mvnw test
```
