# Bounded Sports execution

`sqlite-sports-v1` admits the Sports demo's two sources, three views and fourteen
field definitions through the real production runtime. It supports ordinary
execution from a new SQLite database. Restart, wall-clock adjustment, arbitrary
aggregations and mapped fact retirement remain outside this profile.

The retained configuration is exported from the completed demo at `ad04db9`;
its SHA-256 is `775781cbf4e64abfb9a4a7ea1c61f8e7f904d3e743f5e8e660bec536e9e367ae`.
It preserves the 128-sequence identity window, 16 retained facts per field,
progress limits and 15-second market freshness threshold. Production code owns
fact selection, sums, publication receipts, progress and retirement.

## Endpoint and evidence contract

Sports uses version-two documents and the explicit runtime profile. The prepared
host must advertise `sqliteSports: 1`. A legacy host cannot silently substitute
another profile. Progress actions reuse the existing `progress` actor and
`progress-send` action.

Retirement uses a separate actor and action:

```json
{
  "id": "retire-scoreboard",
  "atMs": 100,
  "kind": "retirement-send",
  "actor": "retirement-control",
  "control": {
    "viewId": "scoreboard",
    "entityId": "match-1",
    "fields": ["homeScore", "awayScore"],
    "minimumBirthSequence": 5
  }
}
```

Declare `retirement-control` with role `retirement`, give it a link, and connect
it before sending. The request goes through production `FactRetirementIngress`.
Malformed control objects reach the production parser and produce its explicit
rejection. The document layer bounds message size and checks actor ownership.

Use `control-receipts` assertions for the complete acknowledgement: kind, status,
reason, normalized control, version, floors and changed views. Retirement field
names are returned in sorted order. Equal-floor repeats return `unchanged` with
the current runtime version; they are not durable publication-identity duplicates.
A rejected mixed-field request changes no floor. Retirement is atomic for one
view; successful retirement of another view is not rolled back by a later rejection.
A storage processing failure is infrastructure failure, never a valid semantic
rejection or passing negative test.

## Ordering, cancellation and replay

Declared sends share the input phase and declaration order with publications and
progress controls. Expiry precedes same-time input. Requests and acknowledgements
cross the existing fixed-latency FIFO links, with distinct retirement channels.
Actor, connection generation, request identity and acknowledgement lineage remain
in the trace. No automatic retirement retry or receipt-loss policy is inferred.

Closing before request arrival cancels the request. Closing after commit can drop
the acknowledgement without reversing retirement. An explicit repeat on a new
connection observes the committed floor. Replay re-executes these operations;
portable bundles preserve their inputs and full evidence without shipping a database.

## Verification boundary

Focused host and document checks cover profile rejection, actual fact strategies,
per-view atomicity, repeated floors, complete acknowledgements, link cancellation,
replay and bundle validation. Tests consume prepared artifacts and never build Java.

The representative two-cycle Sports scenarios, retained-fact/identity boundaries,
wrong-revision runtime control, finite campaign and scoped ordinary
service parity are recorded in [Sports qualification](timeline-sports-qualification.md). This foundation does not claim
that broader evidence or promote the POC to main.

Focused verification passed 102 Java cases across Sports, Order and host protocol,
plus Sports document/contract checks and 33 shared document, fleet, protocol and
packaging regressions. Complete retirement acknowledgements and same-time
publication/retirement expectations were independently checked before execution.
Both declaration orders passed unchanged. A validator regression covers the
production `numericRange` rejection, including its empty floors/changed views;
the Java test separately proves atomic rollback on actual numeric overflow.
