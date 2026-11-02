# Versioned publication ingestion

The v2 API gives each publication an identity. A source can retry after losing an
acknowledgement without applying the same event twice. Reusing that identity for
different content is rejected.

The API supports memory or [SQLite storage](sqlite-storage.md), startup-defined
views, source acknowledgements and HTTP snapshots. The existing demo APIs remain
separate and unchanged.

## Configure and run

Save a configuration such as this as `v2.json`:

```json
{
  "contractVersion": 2,
  "storage": "memory",
  "maxStreams": 100,
  "identityWindow": 1000,
  "maxHistoryEntries": 1000,
  "sources": [{"id": "fleet", "epoch": "trip-1"}],
  "views": [
    {
      "id": "latest",
      "fields": {
        "position": {
          "sourceId": "fleet",
          "type": "position",
          "mode": "latestBySequence"
        }
      }
    }
  ]
}
```

After building the application, run:

```sh
java -jar target/zooglass.jar --zooglass.v2.config=file:/absolute/path/v2.json
```

The default resource contains empty source and view lists. Configuration is
validated before startup: unknown properties, unsupported modes, duplicate IDs,
invalid limits and references to unknown sources fail startup.

Each field binds one source and event type to one existing strategy module:
`arrival`, `latestBySequence` or `historyBySequence`. Different fields can use
different sources. Multiple views can use the same stream differently.

## Send a publication

Connect a WebSocket client to `ws://localhost:8080/v2/events` and send:

```json
{
  "sourceId": "fleet",
  "epoch": "trip-1",
  "sourceEntityId": "car-1",
  "publicationSequence": 41,
  "type": "position",
  "payload": {"latitude": 36.14, "longitude": -5.35}
}
```

The identity is the source, configured epoch, entity and publication sequence.
Sequences must be integers from 1 to 9007199254740991. They apply across event
types within that stream. Payloads must be JSON objects.

A successful response looks like:

```json
{
  "status": "applied",
  "reason": "memory",
  "stream": {"sourceId": "fleet", "epoch": "trip-1", "sourceEntityId": "car-1"},
  "publicationSequence": 41,
  "version": 1,
  "changedViews": ["latest"]
}
```

| Status | Meaning |
| --- | --- |
| `applied` | Identity and all affected views were installed together in memory. |
| `committed` | Identity and all affected views were committed together to SQLite. |
| `duplicate` | The retained identity has the same type and content. No state changes. |
| `rejected` | Invalid envelope, unknown source/epoch, conflicting identity, expired identity or capacity limit. No state changes. |
| `failed` | Processing failed. Retry the same publication; the response does not claim successful application. |

Rejection reasons are `invalidEnvelope`, `unknownSource`, `unknownEpoch`,
`identityConflict`, `outsideRetention`, `streamLimit` and `historyLimit`.
Processing failures use `processingFailure`, without exposing payloads or internal
exception messages.

Comparison ignores object-key order and numeric spelling: 1 and 1.0 are equal.
Array order and JSON types matter. Duplicate object keys and extra envelope
properties are rejected.

The version counts accepted publications, including those matching no view.
Duplicates return their original version with an empty `changedViews` list.
Valid-envelope rejections return the current version; malformed input and
processing failures return a null version.

## Read the result

Request `GET /v2/views/latest/car-1`. Its `data.position` contains:

```json
{"publicationSequence": 41, "payload": {"latitude": 36.14, "longitude": -5.35}}
```

Keeping the envelope sequence outside the payload avoids ambiguity with application
fields. History mode returns an ordered array of these contributions. Latest mode
does not move backwards when an older publication arrives; arrival mode does.

A snapshot includes its view ID, entity ID and last changed version. A known view
with no entity data returns an empty snapshot at version zero. An unknown view
returns 404. Legacy snapshots do not contain v2 data.

## Bounds and restart behaviour

`maxStreams` limits distinct source/epoch/entity tuples. `identityWindow` retains
a sequence range per stream: accepting sequence 100 with a window of 10 advances
its admission floor to at least 91. The floor never moves backwards. Older
publications are rejected, even after their identity records have been discarded.

`maxHistoryEntries` limits each history field. Exceeding it rejects the whole
publication, leaving views, identities and retention floors unchanged. History is
not silently truncated. These are count limits, not a total byte-memory quota.

A source can lose its acknowledgement after application or commit. Retrying recovers a
duplicate result while the identity remains retained. In memory mode, this is not durable
acknowledgement: restarting ZooGlass starts a fresh memory run. SQLite mode
retains state and identities across restart; see the [storage guide](sqlite-storage.md).

V2 live subscriptions, runtime definitions and fact revisions follow in later increments. See the [accepted contracts](../../docs/design/behaviour-contracts.md)
for the wider design.
