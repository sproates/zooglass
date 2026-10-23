# Source progress signals

This is an exploration of how ZooGlass might learn whether an event history is
complete. It compares some common approaches, but it does not choose a product
rule or propose a finished protocol.

## The problem

ZooGlass can order the sequence numbers it has received. That does not tell it
whether a number it hasn't received is late, was never produced, or belongs to
another entity. And even if it knows that sequence 41 is missing between 40 and
42, it cannot know whether to wait unless it has some information about the
source's progress.

Consider this timeline for one vehicle:

| Arrival | Event or signal          | History received so far |
| ------- | ------------------------ | ----------------------- |
| 1       | Position 40              | `[40]`                  |
| 2       | Position 42              | `[40, 42]`              |
| 3       | Position 41 arrives late | `[40, 41, 42]`          |

At arrival 2, the history is ordered but might be incomplete. Without more
information, ZooGlass cannot tell whether 41 is late or whether sequence values
are allowed to skip.

## Possible approaches

| Approach                         | What it tells ZooGlass                                                                                                                                              | Trade-offs                                                                                                                                                                                                            |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No progress signal               | Only which events have arrived so far.                                                                                                                              | Simple and responsive. The view must be treated as provisional; it cannot claim completeness. This is what the prototype does today.                                                                                  |
| Per-entity sequence watermark    | The source guarantees contiguous numbering per entity and reports progress through a value, for example, “no more positions at or below 42 will arrive for car 17”. | Can identify a missing sequence and let the view stop waiting. The source must honour the watermark. A later event 41 violates that promise, or needs a correction/reopen rule.                                       |
| Partition or feed offset         | The source has processed through a position in a shared stream.                                                                                                     | Useful for knowing source progress, but not necessarily enough to detect a gap in one entity's sequence. Other entities may use the intervening positions. The scope of the offset must match the data being checked. |
| Event-time watermark             | The source does not expect more events with an event time earlier than a stated time.                                                                               | Useful for time-based views and windows. It depends on a lateness assumption, and an event arriving behind the watermark needs a defined late-event policy. It is not the same as a sequence watermark.               |
| Processing-time timeout          | Nothing relevant has arrived for a chosen period, so ZooGlass assumes the source is probably done for now.                                                          | Easy to understand, but it is only a guess. A slow source or network delay can look like completion, and late events can still arrive.                                                                                |
| Snapshot or end-of-stream marker | The source has finished a bounded batch or snapshot.                                                                                                                | Can provide a clear completion boundary for imports or bounded queries. It does not by itself describe progress in an ongoing stream.                                                                                 |

For the timeline above, a sequence watermark through 42 arriving after position
42 but before 41 would mean the source promises that 41 will not arrive later.
If 41 then does arrive, ZooGlass needs a rule for treating that as a broken
promise or a correction. A timeout makes a similar decision based on elapsed
time instead of a source promise, so a delayed 41 can still arrive after the
history was treated as complete. An event-time watermark only helps if the
events carry meaningful timestamps and ZooGlass knows how to handle events
that arrive behind it.

## The scope matters

A progress signal needs a clear scope: source, partition, entity, or view. A
feed-wide offset can show that a partition has been read through a point, but
if that feed contains several entities, the missing number for one entity may
be an event for another. This is why the
[`shared-sequence-across-entities` Workbench scenario](../workbench/scenarios/shared-sequence-across-entities.json)
shows car 17 receiving positions 40 and 42 while position 41 belongs to car 22.

A view can also depend on more than one source. Progress from the order service
does not say that the payment service has finished sending relevant updates.
ZooGlass would need to track progress separately for each input, then define
what it means for the combined view to be complete.

## Questions to answer before implementing this

- What does the sequence count, and at what scope is it contiguous?
- Does a progress signal promise that earlier events will never arrive later?
- How does a source report progress when it is idle or has no event for a
  particular entity?
- If a late event arrives behind reported progress, do we reject it, apply it
  as a correction, or reopen the history?
- For a view built from several sources, when can ZooGlass describe the combined
  view as complete?

For now, ZooGlass only orders the events it receives. The
[`sequence-gap` scenario](../workbench/scenarios/sequence-gap.json) shows a
contiguous per-vehicle sequence where 41 arrives late. That is an example of
one possible source contract, not a guarantee ZooGlass currently requires or
validates. No progress protocol or gap-handling policy has been selected.
