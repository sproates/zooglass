# Source progress and late events

Use progress tracking only when a source promises contiguous publication sequences
for each original source entity. If a feed-wide sequence interleaves different
entities, leave progress `untracked`: a numerical jump alone does not prove a gap.
The [v2 ingestion guide](v2-ingestion.md) describes data publications and snapshots.

## Configure a source and its fields

This configuration lets one field incorporate late positions while another rejects
positions arriving behind a source's declared progress boundary:

```json
{
  "contractVersion": 2,
  "storage": "memory",
  "maxStreams": 100,
  "identityWindow": 1000,
  "maxHistoryEntries": 1000,
  "sources": [{
    "id": "fleet", "epoch": "trip-1",
    "progress": {
      "mode": "contiguousSequence", "startSequence": 40,
      "maxReceivedRanges": 64, "maxMissingRanges": 64
    }
  }],
  "views": [{
    "id": "positions",
    "fields": {
      "received": {
        "sourceId": "fleet", "type": "position", "mode": "historyBySequence",
        "late": {"mode": "acceptLate"}
      },
      "strict": {
        "sourceId": "fleet", "type": "position", "mode": "historyBySequence",
        "late": {"mode": "rejectBehindWatermark"}
      }
    }
  }]
}
```

Omitted source `progress` means `{"mode":"untracked"}`. Omitted field `late`
means `{"mode":"acceptLate"}`. Explicit defaults normalise identically.
Reject-behind-watermark requires contiguous progress on every field input.
Source priority still chooses by configured rank, never by progress or cross-source
sequence comparison. Original source keys and epochs scope progress even when
[entity mappings](v2-ingestion.md#map-source-keys-to-view-entities) combine values.

Starting sequences and range bounds are positive integers up to 9007199254740991.
Unknown settings and coercion are rejected. Source contracts and view policies
remain immutable; changing them requires new IDs or a separate run/database.
## Classify a field by receipt age

Add a freshness policy to a v2 field definition:

```json
{"sourceId":"fleet","type":"position","mode":"latestBySequence",
 "freshness":{"mode":"receiptAge","staleAfterMillis":30000}}
```

The field becomes fresh when ZooGlass accepts a change to the selected source's
contribution. At 30 seconds it becomes stale, even if no further event arrives.
A duplicate, watermark or ignored older position cannot refresh it. For history
fields the clock starts again when an event adds a history entry. A lower-priority
source has its own receipt time and cannot refresh the selected source.

Read `status.fields.<field>.freshness` and `receivedAtMillis` in the v2 HTTP snapshot.
The timestamp records when ZooGlass received the update, in UTC Unix milliseconds.
It says nothing about when the event occurred or whether the source is connected.
A timer changes the snapshot version and status while preserving values, provenance
and source receipts. Waiting views still withhold their values.

An absent field reports `absent`. Omit the policy or use `{"mode":"unspecified"}`
to leave populated fields unclassified. After restart, a missing timestamp or a
backwards wall clock yields `ageUnknown` with a null timestamp until a new accepted
change. The threshold must be an integer from 1 through 9007199254740991.

## Wait for required fields

By default a view uses `{"mode":"publishPartial"}` and exposes each field as it arrives.
Omit the policy to use that default. An explicit `"publication": null` fails startup.
To hold values until both order and payment have contributed, add this property to the view:

```json
{"publication":{"mode":"requireContributions","fields":["order","payment"],"maxPendingEntities":50}}
```

Use distinct, declared field names and a positive integer capacity. While waiting,
the snapshot exposes status but its data and provenance are empty. When the last
required field receives a value, ZooGlass exposes all selected fields together,
including any optional fields already present. An empty JSON payload counts.
Source progress, watermarks and business approval do not determine field presence.

Capacity counts entities with held candidates in this view. A status-only entity
uses no slot. An event that would exceed capacity returns `pendingViewLimit` and
changes nothing in any view or source stream. Once a waiting entity receives its
last required field, another entity can use its slot.

## Declare progress

Send data on `/v2/events` as before. Send watermark controls over a separate
WebSocket connection to `ws://localhost:8080/v2/progress`:

```json
{"sourceId":"fleet","epoch":"trip-1","sourceEntityId":"car-1","throughSequence":42}
```

The source promises no **new** publications through 42 will arrive for this exact
source/epoch/entity. Known identity retries remain allowed. A control has no domain
payload and consumes no data publication sequence. It may create a control-only
stream, counting against `maxStreams`, but cannot populate a field or advance the
data identity admission floor. It does not imply that missing publications arrived.

A successful reply is:

```json
{
  "kind": "watermark", "status": "applied", "reason": "memory",
  "stream": {"sourceId":"fleet","epoch":"trip-1","sourceEntityId":"car-1"},
  "throughSequence": 42, "version": 3, "changedViews": ["positions"]
}
```

SQLite replies use `committed`/`sqlite`. Retrying the latest equal boundary returns
`duplicate`, its original advance version, `alreadyApplied` or `alreadyCommitted`,
and empty `changedViews`. Older boundaries return `backwardsWatermark`; historical
control receipts are not retained. This retry behaviour survives SQLite restart.

Other rejection reasons are `invalidProgress`, `unknownSource`, `unknownEpoch`,
`progressUntracked`, `streamLimit` and `progressLimit`. A failed processing/storage
operation returns `failed/processingFailure` with a null version. Malformed
controls also have a null version. Send no control fields to `/v2/events`.

## Read the result

Snapshots now include `status`, alongside existing `data`, `provenance` and
`version`. The `status.inputs` map has one entry per source used by the view:

```json
{
  "state": "observed", "mode": "contiguousSequence", "epoch": "trip-1",
  "sourceEntityId": "car-1", "startSequence": 40, "observedThrough": 42,
  "watermarkThrough": 42, "completeThrough": null, "completeness": "incomplete",
  "admissionFloor": 1, "sourceContractViolated": false,
  "missingRanges": [{"from": 41, "through": 41, "status": "confirmed"}]
}
```

With start 40, receiving 40 then 42 creates provisional gap 41. A watermark through
42 confirms it missing. If 41 arrives before the watermark, the gap closes normally.
If it arrives afterwards, each matching field applies its late strategy:

- `acceptLate` invokes its update module. History adds 41; latest may stay at 42.
- `rejectBehindWatermark` leaves its candidate unchanged.

Either way, this newly admitted publication breaks the source promise. All views
using the stream expose `sourceContractViolated: true` and `completeness: violated`.
The flag persists across restart and later watermarks; a new source/epoch identity
is needed to start a new promise. A duplicate or outside-retention publication is
classified before progress and does not create new effects.

`completeThrough` is a watermark only when every sequence from the configured start
through that boundary was received and the promise remains unbroken. It says nothing
about future events or business completeness. Untracked sources and sources without
a watermark report unknown completeness. Sources progress independently, including
all admitted event types even when those types do not update a field.

`state` is `notObserved` before seeing a stream, or `unmapped` when the canonical
entity has no inverse lookup key. Missing numeric boundaries are null. A known view
with an unseen entity remains an empty version-zero snapshot; reads allocate no state.

`status.publication` is `waiting` while required fields are absent, `partial`
when values are exposed with some fields absent, and `ready` when every field is
present. `missingFields` lists all absent fields and `missingRequiredFields`
lists the absent required ones, both in name order. `status.fields` lists input sources and
the selected contribution’s [receipt-age classification](#classify-a-field-by-receipt-age).

## Outcomes, versions and bounds

Data target outcomes add an ordered `fields` list with `field`, `status`, `reason`
and `changed`. A resolved target is accepted if at least one matching field accepts;
if all reject behind the watermark, the target is rejected with `behindWatermark`.
Unknown mappings still reject without field evaluation. Top-level committed/applied
status records runtime admission, so it may accompany rejected field targets.

`changedFields` and field `changed` flags describe published values/provenance.
`changedViews` and snapshot versions also reflect status changes. First source
observation, admission-floor changes and progress can therefore change a snapshot
without changing its selected value. A hidden update with identical public status
still leaves the snapshot version unchanged. The runtime version advances on each
committed data publication or advancing control. Retries retain original versions
and original field outcomes. Migrated older targets report `fields: null`, meaning
historical field details were not recorded.

Ranges are compact inclusive intervals. The received prefix becomes one scalar;
`maxReceivedRanges` bounds disjoint received ranges beyond it. `maxMissingRanges`
bounds all provisional, confirmed and expired segments, after splitting at watermark
and admission-floor boundaries. Huge jumps do not allocate one object per sequence.
Missing ranges below the data admission floor become expired, never silently repaired.

If a data publication or watermark would exceed a range bound, `progressLimit`
rejects the whole operation. Receipts, floors, progress and all views stay unchanged.
Permanent fragmentation may exhaust capacity; there is no silent deletion or timeout
repair. These are count bounds, not a byte-memory quota. Source progress, target
outcomes and view changes commit together; see [SQLite storage](sqlite-storage.md).
