# Configure ZooGlass

Start with the result your application needs: which sources contribute, how their
keys identify the same entity, and what each field should do with a new report.
A runtime JSON file defines those choices. Separate startup properties select the
file, database path, network listeners and access policy.

This guide covers the service. Workbench's [deterministic timeline](../../workbench/docs/timeline-guide.md)
admits a documented subset of these configurations; service support does not imply
timeline support. Configuration `contractVersion: 2` is a data-format version, not
an API prefix or a timeline document version.

Use the offline [check and explain commands](configuration-inspection.md) to validate
a file and inspect its effective policies before starting the service.

## Choose an example

Both examples below are complete files, not fragments. Run from the repository
root with JDK 25 and Node 26. Prepare `zooglass/target/zooglass.jar` using the
[runtime build instructions](../README.md#run-locally) if it is absent. Example
commands and verification tests never build Java automatically.

| Example | What it demonstrates |
| --- | --- |
| [orders-memory.json](examples/configuration/orders-memory.json) | Map a payment ID to an order, wait for order and payment, select a primary courier and report receipt-age freshness. |
| [sales-sqlite.json](examples/configuration/sales-sqlite.json) | Correct and retract facts, maintain a numeric total, and retain the result and retry identity after restart. |

The examples use open demo access on loopback. For an application deployment,
follow [protected deployment](protected-deployment.md); runtime JSON alone does
not protect either publications or view reads.

### Orders in memory

In one terminal:

```sh
java -jar zooglass/target/zooglass.jar \
  --server.address=127.0.0.1 --server.port=8080 \
  --zooglass.config="file:$PWD/zooglass/docs/examples/configuration/orders-memory.json"
```

After `/actuator/health` reports readiness, use another terminal at the repository root:

```sh
curl --fail http://127.0.0.1:8080/actuator/health
node zooglass/docs/examples/configuration/run-example.mjs orders
```

The script publishes over `/events` and checks actual receipts and HTTP snapshots.
It asserts that the order's data is withheld until its payment arrives, maps
`payment-9` to `order-42`, and selects primary courier sequence 2 over backup
sequence 900. Priority compares configured source rank, not cross-source sequence
numbers. An exact retry returns `duplicate`.

The final `data` is:

```json
{
  "order": {"state": "placed"},
  "payment": {"state": "paid"},
  "delivery": {"state": "delivered"}
}
```

Inspect `status.fields.delivery` to see receipt-age classification. It becomes
stale after 30 seconds without a selected contribution change. Freshness does not
switch to the backup courier or remove the value. Memory state disappears when
the process stops; restart before repeating the complete example.

### Sales with SQLite recovery

Stop the memory example before reusing port 8080. Create an empty directory for
this example and use its absolute path. In one terminal:

```sh
mkdir -p /tmp/zooglass-sales-example
java -jar zooglass/target/zooglass.jar \
  --server.address=127.0.0.1 --server.port=8080 \
  --zooglass.config="file:$PWD/zooglass/docs/examples/configuration/sales-sqlite.json" \
  --zooglass.database=/tmp/zooglass-sales-example/state.sqlite
```

After readiness, run:

```sh
node zooglass/docs/examples/configuration/run-example.mjs sales
```

This creates a sale of 12, corrects it to 15, creates another sale of 5 and retracts
the first. The script checks the correction and the final total of 5. Retraction
removes the first fact from `data.items` but retains its tombstone and consumes
retention capacity until retirement.

Stop the server with Ctrl-C, restart with the **same command and database**, wait
for readiness, then run:

```sh
node zooglass/docs/examples/configuration/run-example.mjs sales-restart
```

The script checks the recovered collection/total and retries the withdrawal:
`duplicate` with `alreadyCommitted` confirms the retained receipt. Use a new empty
directory for a fresh run; do not delete a running database or its WAL files.
The script accepts an optional second argument for a different base URL.

## Build your configuration

1. Declare each source's ID and epoch. Sequence identity belongs to the original
   source/epoch/entity, across all event types in that stream.
2. Define views and fields. Choose how an incoming payload updates each field.
3. Add entity mappings only where source entity keys differ. Add source priority only where
   several sources compete for one field.
4. Decide whether to expose partial data or wait for required field contributions.
5. Add progress, late-event and receipt-age policies only when their semantics
   match the feed contract. Choose storage and limits explicitly.

### Required root settings

| Setting | Accepted value / meaning |
| --- | --- |
| `contractVersion` | Required integer `2`. |
| `storage` | Required `memory` or `sqlite`. The bundled example chooses memory; there is no JSON-schema storage default. |
| `maxStreams` | Required positive 32-bit integer. Maximum distinct source/epoch/entity streams, including control-only streams. |
| `identityWindow` | Required positive 32-bit integer. Retained sequence range per stream, not a count of the last received messages. |
| `maxHistoryEntries` | Required positive 32-bit integer. Maximum entries in each history field. |
| `sources` | Required array of source definitions; IDs are unique. |
| `views` | Required array of view definitions; IDs are unique and each view has at least one field. |
| `delivery` | Optional object; defaults described below. |

The bundled limits 100/1000/1000 are example choices, not fallback values for missing
properties. If sequence 100 is admitted with `identityWindow: 10`, its floor moves
to at least 91; older publications are rejected even after receipt records are
removed. History overflow rejects the whole publication without truncating history.
Stream/history/fact/pending limits count records or entities, not total bytes.

### Sources, views and entity keys

| Setting | Required, default and constraints |
| --- | --- |
| `sources[].id`, `sources[].epoch` | Required nonblank strings. Publications must match both. |
| `sources[].progress` | Omitted: `{"mode":"untracked"}`. No sequence-gap claim. |
| `progress.mode: contiguousSequence` | Requires `startSequence`, `maxReceivedRanges`, `maxMissingRanges`, each an integer from 1 to 9007199254740991. Use only for a contiguous promise per original entity. |
| `views[].id` | Required nonblank view ID. |
| `views[].fields` | Required nonempty object keyed by nonblank output field names. |
| `views[].entities` | Optional source-ID-to-resolver map; each source must be used by that view. Omitted entries use `envelopeEntity`. |
| `entities.<source>.mode: envelopeEntity` | Preserve the envelope entity ID. Does not accept `keys`. |
| `entities.<source>.mode: lookupEntity` | Requires `keys`, an exact string-to-string map. Nonblank keys/values, unique target per source. No trimming/coercion; a missing mapping rejects that view's contribution. |
| `views[].publication` | Omitted: `{"mode":"publishPartial"}`. Expose fields as they arrive. |
| `publication.mode: requireContributions` | Requires distinct declared `fields` and `maxPendingEntities` in 1–9007199254740991. Hold data until every required field has contributed; status remains visible. |

Different sources can map to the same canonical entity. Two keys of the **same**
source cannot map to one entity, because that would merge independent sequence
domains. A view resolver never changes publication/retry identity.

Required contributions are presence checks, not business approval or a freshness
threshold. An empty payload counts. Pending capacity counts entities with held
candidates, and exceeding it rejects the publication atomically.

### Field inputs and strategies

Every field requires `mode` and either `sourceId` plus `type`, or a nonempty `inputs`
array of `{sourceId, type}` objects. Do not mix the forms. Sources must be declared,
types nonblank and source/type pairs unique. The field name is the containing JSON
key; `name` and `update` are not supported properties.

| Field setting | Behaviour and restrictions |
| --- | --- |
| `mode: arrival` | Replace with the last admitted payload in arrival order. |
| `mode: latestBySequence` | Retain the highest envelope publication sequence from each input source. |
| `mode: historyBySequence` | Retain payloads ordered by envelope sequence, bounded by `maxHistoryEntries`. |
| `mode: activeFacts` | Return active fact records ordered by birth sequence. Requires `facts`; forbids `property`. |
| `mode: sumActiveFacts` | Sum the top-level numeric `property` of active facts. Requires `facts` and a nonblank `property` name. |
| `conflict` | Omitted or `independentFields`: one distinct input source. Multiple event types from that source may share an ordinary field. |
| `conflict.mode: sourcePriority` | Requires `latestBySequence` and `sources` listing each input source exactly once, highest priority first. |
| `late` | Omitted: `{"mode":"acceptLate"}`. `rejectBehindWatermark` requires contiguous progress for every input source. |
| `freshness` | Omitted: `{"mode":"unspecified"}`. `receiptAge` requires `staleAfterMillis` in 1–9007199254740991. |
| `facts` | Exactly one input; no source-priority conflict. Requires `revision` (`firstFact` or `latestFactRevision`), `maxRetainedFacts` and `minimumBirthSequence` in 1–9007199254740991. |

`untracked`, `publishPartial`, `independentFields` and `unspecified` do not accept
parameters belonging to their alternative strategies. Facts/property settings on
ordinary update fields are rejected. Fact fields can still use entity mapping,
late-event, receipt-age and required-contribution policies.

Priority selects the highest-ranked **present** candidate, without freshness
fallback. Receipt age measures accepted contribution changes, not source event
time or connection health. Retries, ignored old payloads and watermarks do not
refresh it. Contiguous progress, watermarks, freshness and required contributions
are separate concepts; see [source progress](source-progress.md) for their wire
messages and status semantics. See [facts](fact-collections.md) for create/revise/
retract, sums and retirement; a new publication sequence alone is not a correction.
Sum properties are top-level JSON numbers, not strings or JSON paths. Inputs and
totals must fit 38 decimal digits and at most 18 fractional places after trailing
zeros are removed; invalid or out-of-range contributions reject the publication.

### Delivery settings

These configure viewer connections, not how source publications are reconciled.

| `delivery` property | Default | Constraints |
| --- | --- | --- |
| `recovery` | `freshSnapshot` | Only supported recovery mode; reconnect and resubscribe for a new full baseline. |
| `slowClient` | `disconnectOnOverflow` | Or `coalesceLatestState`, which replaces waiting updates per subscription while preserving baselines and replies. |
| `maxQueuedMessages` | `128` | Integer from 2 through 2147483647. |
| `maxQueuedBytes` | `1048576` | Positive signed 64-bit integer; UTF-8 payload budget per connection. |

FIFO or coalescing overflow requests close code 1013. A single oversized message
or opening acknowledgement/baseline pair requests 1009. These limits are not
replay retention. See [live delivery](../README.md#live-subscriptions).

## Startup and deployment reference

| Property | Default / requirement |
| --- | --- |
| `zooglass.config` | `classpath:runtime-views.json`; use `file:/absolute/path/views.json` for your runtime JSON. |
| `zooglass.database` | Required nonblank path when storage is SQLite. Existing parent directory, local filesystem, one service owner. |
| `zooglass.report-port` | Opt-in `true` enables a Spring port-file writer for local tooling; omitted by default. |
| `server.port`, `server.address` | Spring listener settings; default port 8080. Examples bind loopback explicitly. |
| `zooglass.access.mode` | `openDemo`, or `applicationPolicy` for protected serving. Open demo mode rejects protected-only settings. |
| `zooglass.access.tenant` | Required in protected mode; nonblank, without outer whitespace. SQLite ownership must match. |
| `zooglass.access.policy-url` | Required absolute HTTPS URL; no credentials, query or fragment. |
| `zooglass.access.service-token` | Required policy-service token; keep outside source control. |
| `zooglass.access.origin` | Required HTTPS browser origin, without path/trailing slash, credentials, query or fragment. |
| `zooglass.access.session-cookie` | `session`. See [credential rules](access-policy.md). |
| `zooglass.access.timeout-ms` | `1000`; allowed 1–5000. |
| `zooglass.access.max-concurrent` | `32`; allowed 1–256. |
| `zooglass.access.operator-port` | Required protected-mode port 0–65535; use a fixed port for deployment. Binds `127.0.0.1`. |
| `zooglass.access.operator-token` | Required distinct token, at least 32 valid token characters; must differ from policy-service token. |

Supply deployment settings through Spring properties/CLI/environment; do not put
them inside the runtime JSON. [Protected deployment](protected-deployment.md)
provides the full TLS properties example and secret placeholders. It requires
direct TLS, HTTP/2 disabled and explicit `server.forward-headers-strategy=none`.
It forbids a separate management listener, Tomcat remote-IP settings, management
endpoint remapping and a changed `/actuator` base path. The loopback operator
listener handles trusted writes; the viewer listener handles authorised reads.

## Validation and configuration changes

ZooGlass validates the JSON before serving requests. Unknown properties, duplicate
keys, trailing JSON, unsupported strategies, invalid references and numeric/string
coercion fail validation. Integers must be integers, not numeric strings or fractional
values. Prefer omitting optional settings; explicit `null` is not a universal synonym
for the default (for example, `delivery`, `publication` and `facts` reject it).

Editing the file does **not** hot-reload the running service. Restart to apply startup
changes. Memory restarts start empty. SQLite restarts verify compatibility:

- Existing source IDs, epochs, progress contracts, views and the three root limits
  must remain compatible. Changing or removing them fails startup.
- Reordering definitions and adding sources/views is supported. Input order is
  normalised; source-priority order remains meaningful.
- Delivery settings are process-local and may change on restart; they are excluded
  from the durable configuration comparison.
- `POST /views` registers a new validated view using existing sources. It starts
  empty, without backfill; retries of old accepted publications cannot seed it.
  Update the startup file to include the registered definition before SQLite restart.

Use a new view ID for changed mappings or policies, and a separate run/database
for incompatible source/retention changes. Keep existing data until migration and
rollback requirements are understood. Protected tenant adoption is an explicit
offline operation; see [SQLite ownership and recovery](sqlite-storage.md).

For troubleshooting, read startup validation errors before publishing. For accepted
publications, inspect the receipt's per-target/per-field outcomes: `applied` or
`committed` alone does not promise that every matching target accepted the value.
[Publication ingestion](publications.md) defines the full receipt contract.
