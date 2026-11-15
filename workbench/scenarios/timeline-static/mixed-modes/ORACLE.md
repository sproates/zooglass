# Mixed static selection witness

This hand-authored V3 witness uses kiln readings to exercise one reusable static
configuration: arrival, latest by sequence and history by sequence in the same
view; two event-type aliases per field; two entities; and one subscriber to both
entities. It is not a converted legacy scenario and has no conversion report.

The literal expectations in [scenario.json](scenario.json) were authored from the
production contracts and source before the witness was executed. The tables below
are the independent choices behind those literals. Execution checks the choices;
it does not supply or regenerate them. Qualification results belong to the
separate evidence report, not this oracle.

## Inputs and selected values

All three fields accept `temperature.measured` and `temperature.corrected` from
`kiln-feed`, epoch `batch-7`. Here `corrected` is an event-type alias with a new
publication sequence, not a revision of an existing publication identity.

| Virtual time | Entity | Alias                 | Sequence | Literal payload                            | Installed version |
| ------------ | ------ | --------------------- | -------- | ------------------------------------------ | ----------------- |
| 10 ms        | kiln-a | temperature.measured  | 10       | `{ "temperatureC": 720, "sample": "A10" }` | 1                 |
| 15 ms        | kiln-b | temperature.measured  | 10       | `{ "temperatureC": 610, "sample": "B10" }` | 2                 |
| 20 ms        | kiln-a | temperature.measured  | 12       | `{ "temperatureC": 760, "sample": "A12" }` | 3                 |
| 30 ms        | kiln-a | temperature.corrected | 11       | `{ "temperatureC": 740, "sample": "A11" }` | 4                 |
| 35 ms        | kiln-b | temperature.corrected | 11       | `{ "temperatureC": 625, "sample": "B11" }` | 5                 |

The sample labels identify whole payload objects, not strings substituted for
those objects in assertions.

| Checkpoint         | Arrival | History, in sequence order | Latest |
| ------------------ | ------- | -------------------------- | ------ |
| kiln-a after 10 ms | A10     | A10                        | A10    |
| kiln-b after 15 ms | B10     | B10                        | B10    |
| kiln-a after 20 ms | A12     | A10, A12                   | A12    |
| kiln-a after 30 ms | A11     | A10, A11, A12              | A12    |
| kiln-b after 35 ms | B11     | B10, B11                   | B11    |

The 30 ms checkpoint distinguishes all three strategies. Arrival replaces the
current payload; history inserts sequence 11 before sequence 12; latest retains
sequence 12. Replacing latest-by-sequence with arrival must fail that literal
checkpoint. Sequence 10 on kiln-b is independent of sequence 10 on kiln-a because
the stream identity includes the source entity. At 40 ms, kiln-a retains stored
version 4 and kiln-b has stored version 5; a publication to the other entity does
not change an installed snapshot's version.

These choices follow
[ArrivalReplacement](../../../../zooglass/src/main/java/io/zooglass/strategy/update/ArrivalReplacement.java),
[LatestBySequence](../../../../zooglass/src/main/java/io/zooglass/strategy/update/LatestBySequence.java),
[HistoryBySequence](../../../../zooglass/src/main/java/io/zooglass/strategy/update/HistoryBySequence.java)
and [ViewTransitions](../../../../zooglass/src/main/java/io/zooglass/runtime/ViewTransitions.java).

## Full observations

The 14 assertions comprise five source-accepted checks, five exact public-data
checks, two full final installed snapshots, one cumulative list of five full
receipts, and one cumulative list of nine full subscriber frames. Assertions at
a send's timestamp observe the settled frame. No same-time legacy operation order
is being approximated.

Every receipt is applied in memory, with versions 1 through 5 and one accepted
target. Field outcomes are ordered arrival, history, latest. The fourth receipt
reports only arrival and history in `changedFields`; latest remains accepted with
`changed: false`. The other four receipts report all three fields changed. These
are full [PublicationOutcome](../../../../zooglass/src/main/java/io/zooglass/runtime/PublicationOutcome.java)
and [BoundView](../../../../zooglass/src/main/java/io/zooglass/runtime/BoundView.java)
expectations, in addition to the narrower source-accepted assertions.

The observer connects at time zero, subscribes to kiln-a at 1 ms and kiln-b at
2 ms, before any publication. Its nine frames, in order, are:

1. Subscription acknowledgment for kiln-a.
2. Empty kiln-a snapshot, version 0.
3. Subscription acknowledgment for kiln-b.
4. Empty kiln-b snapshot, version 0.
5. Kiln-a update, version 1.
6. Kiln-b update, version 2.
7. Kiln-a update, version 3.
8. Kiln-a update, version 4.
9. Kiln-b update, version 5.

Installed snapshots retain `{ publicationSequence, payload }` envelopes. Public
frames unwrap those envelopes into `data` and retain the sequences separately in
`publicationSequences`, using the production
[ViewSnapshot.from](../../../../zooglass/src/main/java/io/zooglass/api/ViewSnapshot.java)
projection. The public-data checks compare the unwrapped payloads. Full raw
snapshots and frames therefore deliberately have different data shapes.

Before the first publication for an entity, its data, provenance and public
sequence maps are empty, publication is partial, all three fields are missing and
absent, and the source is not observed. Afterwards, all fields are present and
publication is ready. Freshness is unspecified, so received-at timestamps remain
null. Progress is untracked, so its sequence-progress values remain null and
completeness remains unknown. Observed admission floors are 1: the identity
window is 20 and the largest sequence is 12. Empty snapshots have a null floor.
These values follow
[ViewStatus](../../../../zooglass/src/main/java/io/zooglass/runtime/ViewStatus.java)
and [ViewCoordinator](../../../../zooglass/src/main/java/io/zooglass/runtime/ViewCoordinator.java).

## Bounds and limits

[runtime.json](runtime.json) pins explicit limits of 20 streams, a 20-sequence
identity window, 20 history entries, 128 queued delivery messages and 1 MiB of
queued delivery bytes. Omitted production options select accept-late input,
unspecified freshness, untracked progress, envelope entity routing, partial
publication and fresh-snapshot delivery. No receipt-age or completeness claim is
made.

The source connects once at zero. Both links have zero latency; there are no
faults, retries, lifecycle restarts or runtime controls. At the 40 ms horizon,
there must be no future tasks, pending messages or held frames. This witness
covers the stated static configuration and its literal observations; it does not
establish performance, arbitrary configurations or fault-recovery behaviour.
