# Protected deployment

ZooGlass asks your application policy service who may read each view and entity.
It checks the decision at admission and delivery, renews active subscriptions and
closes them when access is lost. See the [policy protocol](access-policy.md).

## Two connections

- **Viewer:** the main HTTPS/WSS listener. It accepts snapshot reads and live
  subscriptions. HTTP reads require HTTP/1.1.
- **Operator:** a separate HTTP/WebSocket listener bound to `127.0.0.1`. Trusted
  local producers use a distinct bearer token. It accepts `/events`, `/progress`,
  `/facts/retire`, `POST /views` and `GET /actuator/health`. It serves no viewer reads.

The operator listener is for processes on the same host. Do not publish it through
a proxy or container port mapping. Remote source adapters should forward through
an application-owned local producer. Browser Origin headers are refused there.
The operator token is separate from both viewer credentials and policy-service
authentication; use a randomly generated value of at least 32 token characters.

## Configuration

Put these settings in a Spring properties file, supplying your own paths and origin:

```properties
server.port=8443
server.ssl.enabled=true
server.ssl.key-store=file:/etc/zooglass/viewer.p12
server.ssl.key-store-type=PKCS12
server.ssl.key-store-password=${VIEWER_KEYSTORE_PASSWORD}
server.http2.enabled=false
server.forward-headers-strategy=none

zooglass.access.mode=applicationPolicy
zooglass.access.tenant=customer-a
zooglass.access.origin=https://application.example
zooglass.access.policy-url=https://policy.example/zooglass/decision
zooglass.access.service-token=${POLICY_SERVICE_TOKEN}
zooglass.access.session-cookie=session
zooglass.access.timeout-ms=1000
zooglass.access.max-concurrent=32
zooglass.access.operator-port=9091
zooglass.access.operator-token=${OPERATOR_TOKEN}
```

Run the prepared service with that file and your view configuration:

```sh
java -jar zooglass/target/zooglass.jar \
  --spring.config.additional-location=file:/etc/zooglass/protected.properties \
  --zooglass.config=file:/etc/zooglass/views.json
```

Use the normal JVM trust store for the policy service certificate; a private CA
requires a configured Java trust store. TLS verification is never disabled.
For durable storage, choose `sqlite` in the view configuration and supply
`--zooglass.database=/path/to/state.sqlite`. The store must belong to the configured
tenant. See [ownership and offline adoption](sqlite-storage.md#tenant-ownership).

Startup refuses missing settings, plaintext viewer configuration, HTTP/2,
forwarded-header processing and a separate management listener. Set
`server.forward-headers-strategy=none` explicitly, including on cloud platforms.
Do not configure `server.tomcat.remoteip.*`: those settings can enable a native
forwarding valve independently of the strategy.

Protected serving keeps the management base path at `/actuator` and forbids
`management.endpoints.web.path-mapping.*`. This prevents another management
endpoint from replacing the permitted health route. A malformed
protected configuration never falls back to open demo mode. Port zero is supported
for ephemeral local test listeners; use a fixed operator port for deployment.

## Recovery and current scope

A restarted process restores durable views, not grants. Each HTTP request and each
new subscription obtains a new decision. A denied former viewer cannot recover its
old permission by reconnecting. Memory-mode restart starts with empty view state.

Real-interface acceptance tests cover local publication and registration, listener
separation, revocation during silence, unaffected authorised viewers, and fresh
permission decisions after restart with both storage modes. Workbench and demo
access-loss acceptance follows separately.

The verified deployment terminates TLS at ZooGlass. TLS-terminating proxies and
remote operator listeners are not supported by this configuration.
