# Retained fact collections and sums

Use `activeFacts` when a source can correct or withdraw an earlier fact. ZooGlass
keeps its revision state and returns the current active collection. A higher
publication sequence alone is not a correction: each fact has a stable birth
sequence and its own revision number.

## Configure the field

Inside an existing [view configuration](publications.md), define:

```json
{
  "goals": {
    "sourceId": "match-feed",
    "type": "goal",
    "mode": "activeFacts",
    "facts": {
      "revision": "latestFactRevision",
      "maxRetainedFacts": 200,
      "minimumBirthSequence": 1
    }
  }
}
```

The source registry declares `match-feed` and its epoch. Exactly one input is
allowed. The equivalent single-input `inputs` form is supported; source priority
and multi-source fact collections are not. A numeric field can consume the same input and calculate a total.

Choose `latestFactRevision` to follow changes, or `firstFact` to keep the first
accepted create. The same feed can populate separate views with these different
policies. Fact state belongs to each field. Existing entity mapping, late policy,
receipt age and required-field publication remain available.

`maxRetainedFacts` counts active facts and tombstones, per view/entity/field.
Exhaustion rejects the whole publication with `factLimit`. Retire old births to
reclaim capacity; retraction alone does not free a slot.

## Publish a fact and its revisions

Send to `/events`:

```json
{
  "sourceId": "match-feed",
  "epoch": "match-1",
  "sourceEntityId": "game",
  "publicationSequence": 40,
  "type": "goal",
  "fact": { "birthSequence": 40, "revision": 1, "operation": "create" },
  "payload": { "scorer": "Player A" }
}
```

A correction has a new publication sequence, the same birth and type, a higher
revision, operation `revise` and a full replacement payload. A withdrawal uses
`retract` and `{}` as payload. A higher `revise` can restore a withdrawn fact.
All sequence/revision numbers must be positive integers no larger than
9007199254740991. Create requires birth equal to publication sequence and revision
1; later operations require a publication after birth and revision at least 2.

The collection is ordered by birth sequence and contains
`{birthSequence, revision, payload}` for each active fact. Withdrawn facts disappear
from the result but retain a tombstone. After the first accepted create, an empty
collection remains present, so it can still satisfy a required-field rule.

HTTP snapshots include `status.fields.<name>.facts` with `minimumBirthSequence`,
`retainedCount` and `activeCount`. The result describes the retained window,
not an unlimited historical audit trail. Live subscribers receive installed fact and status changes.

## Retries, failures and progress

| Situation | Outcome |
| --- | --- |
| Exact publication retry | Original receipt; no repeated effect. Fact metadata is part of identity comparison. |
| Same identity with changed metadata or payload | `identityConflict`. |
| Revision before its create | Whole publication rejected as `unknownFact`, with the first dependent view/entity/field identified in `targets`. Retry the same publication after the create arrives. |
| Lower revision | Target rejects with `obsoleteRevision`. |
| Equal revision and same canonical content | Target unchanged; no age refresh. |
| Equal revision with conflicting content | Target rejects with `revisionConflict`. |
| Alteration in a first-fact field | Target rejects with `factImmutable`; other targets may accept. |
| Fact type changes while any field retains the birth | Whole publication rejected as `factTypeMismatch`, before type routing. |
| Birth below a field's retirement floor | Target rejects with `factOutsideRetention`. |
| Ordinary envelope reaches a fact field | Target rejects with `factMetadataRequired`; ordinary fields can still process it. |
| Fact envelope but no fact fields configured anywhere | `factsNotConfigured`; keeps the old storage format unchanged. |

Whole-publication rejection consumes neither identity nor source progress and
installs no staged target change. A deterministic target policy rejection can be
recorded alongside accepted targets in one admitted receipt. A retry of that
receipt returns its recorded outcomes rather than trying the rejected fields again.

The late policy compares the correction's publication sequence with its source
watermark, not its old birth sequence. Admitted obsolete revisions still count as
received publications. Different views do not share their fact revision state.

A new view has no backfill. Its unknown-fact dependency can block a correction
that other views know about. For a new seeded view, use explicit new source/epoch
configuration with fresh creates; replaying already admitted creates won't seed it.

## Retire old facts

Send a control to `/facts/retire`:

```json
{
  "viewId": "match",
  "entityId": "game",
  "fields": ["goals"],
  "minimumBirthSequence": 41
}
```

The entity is the view's canonical entity ID. All named fields must belong to the
same source and mapping. The control deletes active records and tombstones with
birth **below** the new floor, recalculates the collection and advances the floors
atomically. A retirement before any create retains the floor without inventing
field presence. Empty floor records use the existing stream and pending-view
capacity budgets.

The response has `kind: factRetirement`, `status`, `reason`, `control`, `version`,
`floors` and `changedViews`. An equal-floor retry is `unchanged` and reports current
state, not a historical receipt. A lower floor is `backwardsFactFloor`; invalid
requests, unknown mappings or capacity failures change nothing.

Retirement never advances source progress or refreshes receipt age. Reserving
capacity before the first event leaves the input `notObserved`, including after
a restart, and does not change other views sharing that input. It can visibly
remove facts from a collection, so name every field whose retained window should
move together. Controls span one view; different views can retain different windows.

Publication retention is independent. An old create's receipt can expire while
a new publication still corrects its retained fact. Once its fact floor passes
the birth, new deliveries cannot restore it. A retained duplicate receipt still
returns its original outcome without reintroducing the retired fact.

## Calculate a score

Add this field alongside `goals` to publish the score and the corresponding list
of goals together. The `property` names a top-level JSON number in each payload.

```json
{
  "score": {
    "sourceId": "match-feed",
    "type": "goal",
    "mode": "sumActiveFacts",
    "property": "points",
    "facts": {
      "revision": "latestFactRevision",
      "maxRetainedFacts": 200,
      "minimumBirthSequence": 1
    }
  }
}
```

Two one-point goals give a score of 2. Correct the first to two points and the
score becomes 3. Withdraw it and the score becomes 1. Once the last goal is
withdrawn or retired, the field publishes zero. Before its first create it is absent.

Both projections use the same publication transaction. A missing, null or
non-numeric `points` value rejects the publication with `invalidNumericContribution`.
Retractions carry an empty payload. Each input and the final total must fit 38
decimal digits, counting integer places implied by an exponent, with up to 18
fractional places after removing trailing zeros. ZooGlass adds exactly and
reports `numericRange` if a bound is exceeded. A withdrawal or retirement can
also overflow when it removes an offsetting negative amount. On rejection the
previous score, collections and floors remain available.

## Storage and freshness

Memory mode says `applied`; SQLite says `committed`. Fact-enabled SQLite databases
use schema 6, including when receipt-age freshness is unspecified. Existing
non-fact configurations keep schema 4 or 5. Keep a pre-upgrade backup if a return
to an older binary is needed. Migration, recovery validation and configuration
changes commit together; failures leave the previous database intact.

Records, tombstones, floors, projections and receipt outcomes are persisted
atomically. Recovery validates provenance and type, checks bounds and recomputes
each active projection before serving. Corrupt or incompatible state prevents
startup; ZooGlass does not silently replace it with empty memory.

With receipt age, an accepted change to fact state refreshes the field. Equal or
obsolete revisions, retries, controls and retirement do not. A retirement does
not postpone an existing stale deadline. Freshness describes the field's last
accepted source change, not the freshness of every record in its collection.

See the [design](../../docs/design/fact-revisions.md) for the strategy modules,
retention rules and numeric limits.
