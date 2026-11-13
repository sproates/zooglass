# Sports sources and configured views

This source foundation runs three fictional matches through a real SQLite-backed
ZooGlass service. It supports finite and repeating operation using the same
schedule. The [continuous Sports browser](../../demos/live-sports/README.md) consumes these
views separately; the accepted static prototype remains a design reference.

From `workbench`, with Node 26, Java 25, installed dependencies and a prepared
`zooglass/target/zooglass.jar`:

```sh
npx tsx src/demos/sports/main.ts
npx tsx src/demos/sports/main.ts --cycles 3 --tick-ms 10
```

The first command runs until Ctrl+C, at a three-second checkpoint interval.
The second accelerates the identical schedule and exits after three cycles.
Neither command builds Java. See the [Workbench setup](../README.md) if the JAR
has not been prepared. Each run owns a fresh database and shuts down its sources
and service on exit. Starting a new producer against an old run's identities is
not supported.

The command prints a URL such as `/views/match-market/match-1`. While it runs,
read `match-1`, `match-2` or `match-3` through any of these views:

| View             | Configured result                                                                                                                        |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `match-market`   | Latest match metadata and bookmaker market; corrected home/away goal collections and scores.                                             |
| `scoreboard`     | Match metadata and corrected scores; no bookmaker dependency.                                                                            |
| `first-reported` | Match metadata, goal collections and scores using the first accepted fact, retaining the first report after corrections and withdrawals. |

`match-feed` and `bookmaker` use independent sockets and independent contiguous
publication sequences for each match. Match event types share one sequence
allocator. Goal collections include zero-point kickoff baselines; presentation
should select `kind: goal` when listing scorers. Scores come from ZooGlass
`sumActiveFacts`, never from adding a received browser list.

## What happens

The first match starts with metadata, then a home baseline and an away baseline.
Before each baseline arrives its score is absent. Both baselines establish 0–0.
The schedule then exercises:

- Alex's goal, followed by Sam's delayed goal. Taylor's correction arrives before
  Sam's create and is rejected as `unknownFact`. The exact correction is retried
  after the create; corrected views report Taylor while first-reported keeps Sam.
- Alex's withdrawal arrives before an older scorer revision. Corrected views
  remove the goal and reject the late revision as `obsoleteRevision`;
  first-reported rejects both alterations as `factImmutable`. The admitted late
  publication still closes its progress gap. An exact retry is a duplicate.
- A market based on match publication 6 is behind observed match progress 8.
  A later bookmaker update catches up. Only the first cycle omits bookmaker
  publication 2 and declares a watermark through 3, confirming that loss.
- A real bookmaker socket outage while match metadata keeps advancing. Default
  pacing exceeds the 15-second receipt-age limit. Reconnecting does not refresh
  old odds; a new accepted publication does. Accelerated runs compress this
  silence, so the freshness test waits for the actual deadline separately.
- Normal away goals and different final scores on the other two matches. The
  first match withdraws every goal, leaving both baselines and a valid 0–0.

Market basis and freshness answer different questions. Compare
`market.basedOnMatchSequence` with `status.inputs["match-feed"].observedThrough`
and require matching cycles. Display progress gaps separately. Fact projections
have no `publicationSequences` list; that list is not a match progress clock.

## Moving to the next cycle

The producer drains delayed publications before retiring the old window in all
three views. Each control names all that view's fact fields and the next allocated
match sequence. ZooGlass applies each view's retirement atomically; the three
controls are not a cross-view transaction.

The runner validates committed or equal-floor unchanged replies, echoed view,
entity and field names, and every returned floor. Transport uncertainty permits
one exact retry. A rejected, malformed or still-unacknowledged control fails the
run visibly and prevents new-cycle publication, even if an earlier view already
committed. It does not roll that view back.

Retirement leaves present, empty fact fields and zero totals. The last match
metadata and bookmaker market still belong to the old cycle. New metadata names
`scoreWindowStart`, then home and away baselines arrive separately. A consumer
should present a current score only when both score fields have that floor and
both have a positive `activeCount`. Empty or mismatched windows are a transition,
not a new 0–0. The acceptance test checks fresh subscribers at each boundary.

The first transition also retries a retained old create receipt and delivers a
new correction to its retired birth. The duplicate cannot restore the fact; the
new correction receives `factOutsideRetention` in every affected field.

## Verification and bounds

```sh
npx tsx --test test/scenarios/sports-*.test.ts
```

The tests use the prepared JAR and independently written expected scores, lists,
receipts and progress. They cover three complete cycles, actual receipt-age
expiry, partial retirement rejection, suppressed committed acknowledgement and
exact retry, cancellation and visible failure. A 40-cycle run exceeds the
128-identity window on both sources, then inspects SQLite after orderly shutdown:
three entities, nine view rows, six streams, bounded receipts, fact records
(including tombstones), and progress ranges. Only the first permanent gap remains,
then ages to expired.

The lazy schedule holds a fixed set of delayed events per match and at most two
actions per checkpoint. Source sockets capture no message history. The browser host retains at most 20 explanatory notices separately. This is bounded-state evidence, not a throughput or heap
benchmark. General producer restart, new-view backfill and production feed adapters
remain outside this slice.

The [source map](source-map.md#sports-source-foundation) shows ownership and shared
helpers; the [accepted design](../../docs/plans/live-sports.md) describes both
delivered browser modes. The proposed [acceptance record](../../docs/verification/2026-11-13-sports-acceptance.md)
collects bounds, first viewer baselines and fresh setup. The
[developer comparison](../../docs/sports-developer-value.md) shows actual policy
outcomes and the extra-match/view configuration fixture.
