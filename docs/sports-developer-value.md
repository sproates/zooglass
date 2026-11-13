# What the Sports demo delegates to ZooGlass

Matchroom combines match-feed facts with an independently reporting bookmaker.
The application chooses what the events mean and which policies each view uses.
ZooGlass retains the facts, applies revisions, supplies totals and publishes full
snapshots. The browser displays the results without calculating scores from goals.

The [acceptance record](verification/2026-11-13-sports-acceptance.md) links the
observable evidence. This comparison describes responsibilities, not engineering
hours saved, production readiness or a real sporting feed.

## Same publication, different configured policies

The exact definitions are in
[`configuration.ts`](../workbench/src/demos/sports/configuration.ts). Both
`match-market` and `scoreboard` select `latestFactRevision`; `first-reported`
selects `firstFact`. Goal lists use `activeFacts`, totals use `sumActiveFacts` over
`points`. The three views receive the same match-feed publications.

For match-1 in cycle 1, sequence 5 creates Sam's goal at birth 5. Sequence 6
corrects that birth to Taylor:

```json
{
  "sourceId": "match-feed",
  "epoch": "run",
  "sourceEntityId": "match-1",
  "publicationSequence": 6,
  "type": "home.contribution",
  "fact": { "birthSequence": 5, "revision": 2, "operation": "revise" },
  "payload": { "kind": "goal", "cycle": 1, "scorer": "Taylor Brook", "minute": 12, "points": 1 }
}
```

| Delivery | Corrected views | First-reported view |
| --- | --- | --- |
| Sequence 6 arrives before create 5 | Whole publication rejects `unknownFact`; identity/progress do not advance. | Same rejected publication; there is no known birth to revise. |
| Create 5, then exact retry 6 | Scorer changes from Sam to Taylor; supplied score remains 2–0. | Sam remains and score stays 2–0; targeted fact fields report `factImmutable`. |
| Sequence 8 withdraws Alex's birth 4 at revision 3 | Alex disappears and the supplied score becomes 1–0. | Alex and Sam remain; supplied score stays 2–0. |
| Late sequence 7 revises Alex at revision 2 | `obsoleteRevision` prevents resurrection; delivery progress closes the gap. | `factImmutable` preserves the first create. |
| Exact retry of sequence 8 | Retained duplicate receipt; no second subtraction. | Retained duplicate receipt; no additional effect. |

The [source acceptance test](../workbench/test/scenarios/sports-simulation.test.ts)
checks literal expected lists, totals and receipts through the real service. The
[extension fixture](../workbench/test/scenarios/sports-extension.test.ts) separately
publishes hand-written events for match-4 into an added score-only policy view.
It does not use the production timeline as its oracle.

## Responsibilities

| Work | An equally scoped custom service would own | With ZooGlass |
| --- | --- | --- |
| Retain changing goals | Birth identities, latest accepted revisions, withdrawals and tombstones, with consistent list and sum updates. | Configure fact revision policy plus `activeFacts` and `sumActiveFacts`. |
| Handle duplicates and missing dependencies | Stable publication identity, receipts, dependency rejection and exact retry without duplicate effects. | The identity window and receipt contract distinguish rejected, committed and duplicate publications. |
| Track delivery gaps | Received ranges, provisional/confirmed/expired missing evidence and source watermarks. | Configure `contiguousSequence`; render supplied input status. |
| Keep markets independent | Separate source identities, latest market payload and freshness based on accepted receipt age. | `latestBySequence` plus `receiptAge` for the bookmaker field. |
| Retire old match facts | Persist per-field retention floors and reject new corrections to retired births without restoring old goals. | Explicit `/facts/retire` controls with verified floors and bounded same-control retry. |
| Reconnect viewers | Current baselines, subsequent ordered snapshots, bounded queues and slow-recipient handling. | Subscribe to each view/entity; the application still owns its reconnect policy. |

The application still owns source adapters, event meaning, epochs and sequences,
which policy is appropriate, and when to retire a window. It must preserve exact
retry content and inspect retirement acknowledgements before publishing a new
cycle. ZooGlass does not discover that a goal was incorrect or price a market.

The UI owns selection, subscriptions, responsive layout and explanations. Its
[`model.ts`](../demos/live-sports/src/model.ts) checks score-window metadata and fact
floors/counts before displaying totals. It filters baseline facts from scorer
lists, but never adds them into a score. Its
[`connection.ts`](../demos/live-sports/src/connection.ts) replaces snapshots on
reconnect. Views can transition independently: window gating is presentation of
that fact, not a cross-view transaction guarantee.

Workbench owns the synthetic schedule, faults, checked walkthrough and fresh-store
Reset. Authentication, deployment, operational monitoring and general producer
restart remain application concerns, outside this demo's acceptance.

## Add a match or a view

**Another match.** Existing views use `envelopeEntity`, so match-4 needs no new
mapping or Java projection. The extension test sends its own baseline, goal,
revision and withdrawal; the original views produce their configured outcomes.
A complete extra demo slot also needs metadata and away baselines, roster/team
entries, schedules, expectations and browser subscriptions. Update the fixed
`matchIds` in the source configuration and browser model, the team roster in
`timeline.ts`, and hard-coded three-match labels. Check `maxStreams` and the
retained-state budget for the intended population. The shipped UI remains a
three-match demo; the test is not a dynamic match-management feature.

**Another view.** The test adds `first-score` at startup with one `sumActiveFacts`
field and `firstFact`, then shows it retaining a goal after the corrected scoreboard
withdraws it. It needs no new reducer. Add subscriptions/rendering if users need
that view. If it retains facts, add it to the application's retirement coverage;
the short fixture ends with its store and is not an unbounded producer. Startup
configuration does not imply live view creation, historical backfill or an editor.
A policy outside the supplied strategies could still require core service work.

## Compare the delivered demos

| Demo | Concrete configuration and behaviour | What remains domain-specific |
| --- | --- | --- |
| Fleet | [Continuous composition](../workbench/src/demos/vehicle/continuous/simulation.ts) uses `latestBySequence` so delayed positions do not move a car backwards. Interactive fixtures also demonstrate history. | Journeys, vehicle rendering and observation-age marker styling; that grey marker is not the Sports receipt-age rule. |
| Order | [Order configuration](../workbench/src/demos/orders/configuration.ts) uses source-specific mappings, `sourcePriority`, required contributions, receipt age and progress. Primary courier authority does not compare unrelated source counters. | Payment/stock/fulfilment semantics, key relationships and the chosen courier authority. |
| Sports | [Sports configuration](../workbench/src/demos/sports/configuration.ts) uses retained facts, revision/withdrawal policies, lists, sums and explicit retirement. The same input creates corrected and first-reported results. | Goal identity/meaning, bookmaker basis, cycle boundaries, retirement scheduling and score-window presentation. |

Sports added configuration, source schedules, independent acceptance checks and
browser presentation. It reused the service launcher, source/receipt transports,
snapshot client, HTTP/data proxy and prepared playback controller. Browser controls
were shared with Order. No new ZooGlass Java strategy or core projection was added
for the Sports implementation or this extension fixture.
