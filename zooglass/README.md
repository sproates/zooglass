# ZooGlass runtime

ZooGlass projects identified source publications into configured views. One
coordinator owns reconciliation, atomic installation, snapshots and live delivery.
It supports memory or SQLite storage, retries, independent update strategies,
source priorities, progress, freshness and retained fact revisions.

## Run locally

Use JDK 25, then build and start from this directory:

```sh
./mvnw --batch-mode verify
java -jar target/zooglass.jar
```

The service listens on port 8080. `GET /actuator/health` reports readiness.
The default `runtime-views.json` configures a match view with `match-feed` and
`bookmaker` sources, both using epoch `run`. Supply another configuration with
`--zooglass.config=file:/absolute/path/views.json`. For SQLite, also supply
`--zooglass.database=/absolute/path/state.sqlite`.

The [publication guide](docs/publications.md) defines configuration, wire messages,
acknowledgements, bounds and restart behaviour. Configuration `contractVersion: 2`
is a data-format identifier; there is one runtime and no version-prefixed API.

## Interfaces

| Interface | Purpose |
| --- | --- |
| WebSocket `/events` | Identified source publications and acknowledgements |
| WebSocket `/progress` | Explicit source watermarks |
| WebSocket `/facts/retire` | Advance retained-fact floors |
| POST `/views` | Register a validated view for subsequent publications |
| GET `/views?viewId=…&entityId=…` | Snapshot lookup for opaque IDs, including slashes and dot segments |
| GET `/views/{viewId}/{entityId}` | Current values, provenance and status |
| WebSocket `/views/live` | Subscribe to current and subsequent snapshots |

Every publication supplies `sourceId`, `epoch`, `sourceEntityId`, a positive
safe-integer `publicationSequence`, `type` and an object `payload`. Sequence
ordering uses the envelope's publication sequence, not a field inside the payload.
A retry with the same identity and content returns its retained outcome; conflicting
content is rejected. A source's sequence must be scoped to its epoch and entity.

HTTP snapshots and live updates expose selected payloads under `data`. They also
carry `version`, `provenance`, `publicationSequences` and `status`. An ordinary
field has one publication sequence; a history field has a sequence per item.
Fact projections retain their configured records or numeric aggregate and expose
fact evidence in status. A known view with no contributions returns HTTP 200 with
empty data and explicit status; an unknown view returns 404.

## Live subscriptions

Send this to `/views/live`:

```json
{"action":"subscribe","viewId":"match","entityId":"match-42"}
```

A successful subscribe returns `subscribed` with `"recovery": "freshSnapshot"`,
then a full `view-update` for that view and entity. Wait for the update before
replacing the display. An entity with no retained revision has version zero,
empty data and its current status. Empty data can also occur at a positive version.

Subscribe again after reconnect and accept the new baseline even if its version
is lower. Later updates carry the complete state. Unsubscribe returns
`unsubscribed`. Replay cursors and unsupported recovery modes receive an error.

The startup setting `"delivery": {"recovery": "freshSnapshot"}` selects this
behaviour and can be omitted to use the default.

Malformed JSON receives `Could not read live view request.` A runtime failure,
including unavailable storage, receives `Could not process live view request.`
The connection stays open for further requests; a failed snapshot read does not
admit the subscription. Failed SQLite storage requires service restart recovery.

Subscription admission and snapshot capture share the coordinator monitor with
installation. Each connection has its own writer. Network writes happen outside
the coordinator monitor. One slow viewer can fall behind without delaying other
viewers or source acknowledgements.

### Slow viewers

The default FIFO queue allows 128 waiting messages and 1 MiB of UTF-8 payload
per connection. To keep only the latest waiting update for each subscription,
add this section to the startup configuration:

```json
{
  "delivery": {
    "slowClient": "coalesceLatestState",
    "maxQueuedMessages": 128,
    "maxQueuedBytes": 1048576
  }
}
```

Coalescing moves the replacement to the tail and preserves baselines, replies
and writes already in flight. Use `disconnectOnOverflow` to keep every waiting
update in order. Both policies request close code 1013 when the queue fills.
If a single message or the opening acknowledgement and baseline together
exceed the entire byte budget, the close code is 1009. Increase the budget or
reduce the view size before retrying an oversized baseline.

The [delivery contract](../docs/design/client-delivery.md) covers subscription
generations, queue boundaries and recovery.

## Register a view

POST a view object from the configuration grammar to `/views`. Successful
registration returns 201, a valid existing ID returns 409, and an invalid definition
returns 400. Sources must already be declared in startup configuration. Registration
has no backfill, including retries of publications accepted before registration.
With SQLite, the expanded configuration is committed atomically; use that expanded
configuration on restart. Removing or redefining a registered view is unsupported.

## Tests and ownership

Run `./mvnw --batch-mode clean verify` for Java tests and JaCoCo coverage.
Runtime tests own reconciliation, identity, transaction and recovery assertions;
delivery tests exercise subscription ordering, isolation and failure handling.
Strategy tests include independent generated ordering expectations. Workbench owns
scenario generation, fault orchestration and verification through real interfaces.
It does not calculate replacement ZooGlass results.

See the [source map](docs/source-map.md), [verification map](../docs/testing.md),
[Workbench guide](../workbench/README.md) and [browser demo](../demos/vehicle-tracker/README.md).

## Protected serving

Open demo access is the default. For application-owned permission decisions, see
[protected deployment](docs/protected-deployment.md): HTTPS/WSS viewers, scoped
grants and a separate local operator connection.
