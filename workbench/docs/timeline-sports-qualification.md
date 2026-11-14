# Sports scenarios and qualification

The [bounded Sports profile](timeline-sports-host.md) runs the actual production
fact and retirement strategies. These fixtures qualify that supported combination
without admitting restart or arbitrary aggregation policies.

## Authored scenarios

The ordinary scenario preserves the completed demo at `ad04db9`: three matches,
two cycles, 121 producer steps and 114 publication attempts. The explicit source
clock is `1700000000000 + stepIndex * 3000`; receipt barriers become distinct
millisecond slots. Full original steps, payload timestamps and omitted identities
are checked against an independent export. The exact runtime configuration and
its 15-second freshness threshold are unchanged.

Independent tables declare complete receipts, fact collections, literal scores,
progress, floors, versions and client frames. Expectations do not run a strategy
to calculate an answer. They distinguish absent scores before baselines, valid
zero after withdrawals, and empty retained windows. Corrected and first-reported
views deliberately disagree. The ordinary case checks all three matches through
installed snapshots and one viewer's three match-1 subscriptions. Receipt-age
checks include exact deadlines and same-time input; reconnect does not refresh.

The separate retention case fills all 16 retained home-fact slots, keeps a
withdrawn fact as a tombstone, rejects capacity overflow, and frees capacity by
retirement. A rejected mixed-field retirement leaves another view's committed
floor intact. Publication sequence 129 makes sequence 2 the inclusive edge of the
128-sequence identity window; a later sparse jump expires missing ranges, while
a watermark confirms remaining gaps. Advancing the publication window does not
delete independently retained facts. Lost retirement acknowledgements and explicit
equal-floor repeats retain their complete causal evidence.

This is boundary qualification, not a long-running memory-growth or browser test.
The ordinary document uses five actors and seven connection generations; retention
uses three actors and four connection generations. Both retain the existing
2,000-turn, ten-connection and 16 MiB trace limits.

## Finite evidence gate

Two groups each run in three fresh Node/JVM executions: baseline and the two
established measured Node/JVM timing modes, for six runs. There are no seeded loss
rules, so adding seeds would not add behaviour. The runner uses the existing
120-second workload allowance; other campaigns keep their defaults. Every run
must satisfy the authored complete expectations and match its group's exact trace.

An isolated wrong-policy build replaces only the production selection of
`LatestFactRevision` with `FirstFact`. The unchanged first corrected-scorer receipt
must expose immutable targets where revision should succeed. Normal execution
must pass; mutant runs with and without measured pauses must fail the same named
assertion. Source and nested JAR inventories bind the actual class change. Tests
never build Java; preparation is explicit and isolated.

```sh
npm run prepare:sports-strategy-control -- /tmp/sports-control-prepared
npm run timeline:sports-strategy-control -- /tmp/sports-control-prepared /tmp/sports-control
npm run timeline:sports-repeat -- /tmp/sports-campaign ../zooglass/simulation-host/target/zooglass-simulation.jar 3
npm run timeline:sports-service-parity -- /tmp/sports-parity ../zooglass qualification
```

Use new output directories. Qualification requires reviewed committed inputs and
tooling. Raw runs retain artifact, configuration, executor and environment identity.
The wrong-revision control is a semantic sensitivity check; 70/90 ms host pauses
alone do not cross the demo's 15-second freshness threshold.

## Ordinary-service parity and limits

The scoped service comparison uses the exact SQLite configuration and real source,
progress, retirement, client and HTTP interfaces. Independently authored projections
retain business values, payload timestamps, facts, provenance, readiness, progress
and floors. Only top-level versions and receipt timestamps are excluded from common
state equality. Raw values remain, and duplicate versions are checked relationally.
Public HTTP/client snapshots unwrap ordinary latest contributions; installed
simulator observations preserve their internal contribution wrappers.

The service must emit a spontaneous stale market frame after the original deadline
before any HTTP observation can repair expiry. Reconnection preserves the receipt
sample; accepted market input refreshes it. This is contract parity, not equality
of real socket timing, global version allocation or cross-socket frame order.

Strict replay, an independent raw-evidence audit and a retained release archive
complete the qualification. [Evidence hashes](../evidence/README.md) pin downloadable
raw data; matching executable artifacts and the recorded environment are still
required for replay. No cross-platform trace equality is inferred.

## Qualification results

Tested tooling commit `f45cbed` passed the declared six-run campaign on macOS arm64:
801 authored assertions and 6,948 trace records, with exact equality within each
group under 1,520 measured Node pauses and eight JVM pauses. Ordinary Sports has
1,973 records per run; retention has 343. Expectations were independently reviewed
and committed at `b982c5c` before execution; both fixtures passed unchanged on their
first run.

The actual wrong-revision runtime failed the frozen correction receipt at virtual
54,010 ms in both timing modes; the normal runtime passed. Service parity passed
22 barriers and 66 HTTP projections, with complete source/control receipts and a
spontaneous expiry after the original 15-second deadline, within the five-second
observation bound. All 204 production classes
match across the service, timeline host and prepared normal control runtime.
Strict portable replays verified all 1,973 and 343 records with passing outcomes.

The [retained evidence manifest](../evidence/README.md) links the six raw runs,
control executions, service observations, portable bundles, strict replays and
independent audit. Focused fixture, control, parity and campaign checks pass, as
do type, lint, formatting and source-map checks. This closes representative Sports
qualification within the stated profile; it does not extend restart admission,
qualify browser behaviour or claim cross-platform equality.
