# Publication ingestion

The publication API gives each publication an identity. A source can retry after losing an
acknowledgement without applying the same event twice. Reusing that identity for
different content is rejected.

The API supports memory or [SQLite storage](sqlite-storage.md), startup-defined
views, runtime view registration, source acknowledgements, HTTP snapshots and
live subscriptions. [Source progress and late-event policies](source-progress.md)
add scoped watermarks, bounded missing ranges and per-field late decisions.

For deployments using the original live-view setting `zooglass.views.config`
(or `ZOOGLASS_VIEWS_CONFIG`), migrate the view definitions to the configuration
format below and set `zooglass.config`. Startup rejects the retired setting.

## Configure and run

Save a configuration such as this as `views.json`:

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
java -jar target/zooglass.jar --zooglass.config=file:/absolute/path/views.json
```

The default resource configures the match example described in the [service guide](../README.md). Configuration is
validated before startup: unknown properties, unsupported modes, duplicate IDs,
invalid limits and references to unknown sources fail startup.

Each input binds a source and event type to an update strategy. Single-input
fields support `arrival`, `latestBySequence` and `historyBySequence`. Multi-input
fields from different sources use `latestBySequence` with source-priority selection.
Distinct event types from the same source can share a field under any ordinary update mode. Multiple views can
use the same streams differently.

## Map source keys to view entities

A view can resolve each source's entity keys independently. For example, add this
view alongside a payment-detail view that keeps the original payment ID:

```json
{
  "id": "order-summary",
  "entities": {
    "payments": {"mode": "lookupEntity", "keys": {"payment-9": "order-42"}}
  },
  "fields": {
    "order": {"sourceId": "orders", "type": "updated", "mode": "latestBySequence"},
    "payment": {
      "inputs": [{"sourceId": "payments", "type": "updated"}],
      "mode": "latestBySequence",
      "conflict": {"mode": "independentFields"}
    }
  }
}
```

Declare both sources and epochs in the enclosing configuration. An order event
with source entity `order-42` and a payment event with source entity `payment-9`
then populate different fields of `GET /views/order-summary/order-42`.
The payment-detail view can still expose `payment-9`.

Omitting a resolver selects `envelopeEntity`, which preserves the envelope key.
`lookupEntity` uses exact, case-sensitive strings without trimming or coercion.
Keys and values must be nonblank. Two keys from the same source cannot map to
one canonical entity: that would combine independent sequence domains. Different
sources may map to the same entity. Resolver entries must name sources used by
the view; extra parameters or unsupported modes fail startup.

The shorthand field form and expanded one-input form are equivalent and default
to `independentFields`. Unknown field properties, including `freshness`, `update`
and `name`, are rejected.

Match source and event type before resolving. A missing mapping rejects only
that view's contribution; other matching views may succeed. It allocates no view
entity. The original source entity remains part of publication identity and its
retention floor; a canonical view ID never replaces it.

## Choose between sources

Configure a field with multiple inputs and an explicit priority order:

```json
{
  "inputs": [
    {"sourceId": "courier-primary", "type": "status.updated"},
    {"sourceId": "courier-backup", "type": "status.updated"}
  ],
  "mode": "latestBySequence",
  "conflict": {"mode": "sourcePriority", "sources": ["courier-primary", "courier-backup"]}
}
```

Declare both sources and their entity mappings in the view. The
[complete relationship example](../../docs/design/relationships-and-conflicts.md#configuration)
shows the enclosing view. Input source/type pairs must be distinct; the priority list
must name each source exactly once. Priority with arrival/history modes is rejected.

ZooGlass retains each source's latest candidate separately. Backup sequence 900
wins while the primary is absent; primary sequence 2 then wins because it ranks
first. A later backup update is retained without displacing it. Delayed input is
compared only against that source's candidate. Silence never removes a candidate:
there is no timeout, freshness fallback or withdrawal in this increment.

Hidden candidate updates advance the publication version and persist in SQLite.
They leave target `changedFields` unchanged. Snapshot versions and `changedViews`
also reflect public status: a first source observation, retention-floor change or
tracked progress change is visible even when the selected value stays unchanged.
A winner change advances the snapshot version even if the new winner has identical
payload and sequence, because its provenance changes. Different views may rank the
same sources differently. Changing an existing priority requires a new view ID.

## Send a publication

Connect a WebSocket client to `ws://localhost:8080/events` and send:

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
types within that stream. Payloads must be JSON objects. The publication envelope and its payload share
a limit of 500 nested containers. Storage rows and snapshot responses reserve
additional nesting for runtime metadata. Identifiers, property names and text
values must contain valid Unicode scalar values, including paired surrogates for
supplementary characters.

A successful response looks like:

```json
{
  "status": "applied",
  "reason": "memory",
  "stream": {"sourceId": "fleet", "epoch": "trip-1", "sourceEntityId": "car-1"},
  "publicationSequence": 41,
  "version": 1,
  "changedViews": ["latest"],
  "targets": [{"viewId":"latest","entityId":"car-1","status":"accepted","reason":null,"changedFields":["position"],"fields":[{"field":"position","status":"accepted","reason":null,"changed":true}]}]
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
`identityConflict`, `outsideRetention`, `streamLimit`, `historyLimit`,
`beforeProgressStart` and `progressLimit`.
Processing failures use `processingFailure`, without exposing payloads or internal
exception messages.

Comparison ignores object-key order and numeric spelling: 1 and 1.0 are equal.
Array order and JSON types matter. Duplicate object keys and extra envelope
properties are rejected.

The runtime version counts admitted publications and advancing progress controls,
including those matching no field. Snapshot versions also include status changes.
Duplicates return their original version with an empty `changedViews` list.
Valid-envelope rejections return the current version; malformed input and
processing failures return a null version.

### Target outcomes

`targets` contains one record for each matched view, in configured view order.
A resolved view reports `status: accepted`, its canonical `entityId`, a null
`reason`, and visible `changedFields` sorted by field name. Acceptance does not
promise a value change. For a [view waiting for contributions](source-progress.md#wait-for-required-fields),
the releasing target lists every newly exposed field in `changedFields`, including
fields contributed by earlier events. Its `fields` outcomes cover only this event's
matching fields. Outside release, a delayed latest-value event has empty `changedFields`.
Each target also records sorted `fields` outcomes (`field`, `status`, `reason`,
`changed`). Late-policy rejection may affect one field while another accepts it.
All matching fields rejecting yields a rejected target with `behindWatermark`.
An unknown mapping reports `status: rejected`, `reason: unknownEntityMapping`,
a null entity and no changed fields.

The top-level `applied` or `committed` outcome describes identity admission;
it may accompany only rejected targets. No matching views produces an empty
array. Whole-publication rejections and processing failures return an empty array,
with no staged target successes. All target records, values, provenance and
identity changes share one installation or transaction boundary.

Retained duplicates return their original `targets` and version without evaluating
current mappings. Their top-level `changedViews` remains empty. Schema-1 receipts
migrated from an older database return `targets: null`, meaning the original
outcomes were not recorded. New receipts always contain an array. Targets retained from schemas 1–3 have
`fields: null` because field-level outcome details were not recorded.

Definitions are immutable. Use a new view ID for changed mappings; it starts
empty. Retrying a retained identity cannot populate it. Publish the current fact
under a new publication sequence instead. There is no mapping edit, buffering,
backfill or view retirement API in this increment.

## Read the result

Request `GET /views/latest/car-1`. Its `data.position` contains:

```json
{"latitude": 36.14, "longitude": -5.35}
```

The separate `publicationSequences.position` is `[41]`, avoiding ambiguity with
application fields. History mode returns an ordered array of payloads and a
corresponding array of publication sequences. Latest mode
does not move backwards when an older publication arrives; arrival mode does.

Use `GET /views?viewId=…&entityId=…` for opaque identifiers. Encode each value
as a query parameter, including literal plus signs. This form supports slashes,
`.` and `..` in either ID. The path-based lookup remains available.

A snapshot includes its view ID, canonical entity ID and last changed version.
Its `status` reports missing fields, source progress and, for configured fields,
[receipt-age freshness](source-progress.md#classify-a-field-by-receipt-age).
Its separate `provenance` map identifies each populated field's `sourceId`,
`epoch` and original `sourceEntityId`. For example, the payment field above reports
`{"sourceId":"payments","epoch":"v1","sourceEntityId":"payment-9"}` when
that source uses epoch `v1`. History fields identify their single source as well.
Empty fields have no provenance entry. A known view
with no entity data returns an empty snapshot at version zero. An unknown view
returns 404. Live subscriptions use the same snapshot representation; see the
[service guide](../README.md#live-subscriptions) for admission and delivery rules.

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

Live subscriptions, runtime definitions and fact revisions use this same runtime. See the [accepted contracts](../../docs/design/behaviour-contracts.md)
for the wider design.

## Correcting retained facts

[Retained fact collections](fact-collections.md) add explicit create/revise/retract
metadata, per-field first/latest revision strategies and bounded retirement.
Ordinary update fields keep their existing semantics.
