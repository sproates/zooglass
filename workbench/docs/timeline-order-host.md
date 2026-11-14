# Order simulation host foundation

The prepared Java host now supports the bounded `sqlite-order-v1` configuration
and progress controls through the real production runtime. This is a host/protocol
foundation, **not yet an executable Workbench document profile**. Document admission
still rejects `sqlite-order-v1`; progress actions, acknowledgement assertions,
transport cancellation and replay integration are the next stage of the
[Order/Sports assessment](timeline-order-sports-assessment.md).

## Admitted configuration

Production configuration validation runs first. The separate `OrderTimelineProfile`
then admits only:

- SQLite, up to five sources, two views, four fields per view and seven overall.
- At most 64 streams, 128 retained identities and 64 history entries; the existing
  delivery limits of 128 queued messages and 1 MiB.
- Untracked progress or contiguous sequences beginning at 1, with at most 64
  received and missing ranges each.
- Envelope entity IDs or lookup tables with at most six keys per source/view.
- Latest-by-sequence fields with accepted late input; one matcher without conflict,
  or exactly two distinct-source matchers selected by source priority.
- Unspecified freshness or receipt-age deadlines up to 15 seconds.
- Partial publication, or at most two required fields and six pending entities.

Facts, projected properties, history updates and other policy combinations are
not admitted. These limits preserve the completed Order configuration; they do
not assert every configuration within the boundary has a qualified domain fixture.
The exact pinned configuration is retained as the host test resource
[`order-runtime.json`](../../zooglass/simulation-host/src/test/resources/order-runtime.json).
Its provenance and SHA-256 are recorded in the assessment.

The host requires explicit profile agreement, protocol 2, SQLite availability,
generation 1, start time zero, no wall offset and a new database path. It rejects
an existing file, including an empty one, rather than silently exercising recovery.
Wall-clock adjustment is rejected. Order restart/recovery remains unqualified;
older receipt-age lifecycle profiles retain their existing support.

## Progress protocol

Protocol 2 advertises `sqliteOrder: 1` only when SQLite is available. The bridge
retains this capability and validates distinct `control-receipt` effects. Protocol
1 neither advertises the capability nor admits progress commands/control receipts.
Configuration-only inspection continues to use the unstarted protocol-1 host.

A modeled session with role `progress` accepts the `progress` host command and its
opaque `wire` string. The host invokes production `ProgressIngress`, which parses
the control and advances `ViewCoordinator`. Source/client sessions cannot invoke
this endpoint, and progress sessions cannot publish events. Old profiles cannot
open progress sessions. Wire responses remain complete production watermark
acknowledgements; they are not publication receipts or synthetic success results.

Equal watermark repeats return the original version with
`duplicate/alreadyCommitted`. A watermark can change view status even before data
arrives, and can update multiple mapped views without replacing retained payloads.
Malformed controls produce the production `invalidProgress` response. Semantic
rejections remain separate from caught processing failures: the host checks SQLite
health after each control and fails the turn if storage requires recovery.

The caller orders host commands. A control runs within one virtual turn, including
production expiry before progress, state effects and any scheduled delivery work.
Tasks must be dispatched using the existing time/round/phase/ordinal rules. This
stage adds no document scheduling convention, automatic control retry, acknowledgement
loss model or claim about ordinary cross-socket arrival order.

## Verification

Focused Java checks cover the profile/resource boundary, initial-empty enforcement,
full durable acknowledgements, exact progress gaps, required contributions, lookup
mapping, stale-primary selection and deadline expiry. Two-client tests verify
progress-driven state/frame order for both view declaration orders. Test-only fault
injection on the owned SQLite connection verifies a failed commit cannot acknowledge
a successful host turn; no fault hook is added to shipped runtime code.

Prepared-process tests exercise capability negotiation, role isolation, real
watermark receipts, old-profile isolation and continued document rejection.
Existing fleet/SQLite host tests and the earlier semantic-record comparison remain
regression gates. All execution/tests consume prepared artifacts; preparation is a
separate explicit command. Full Order scenarios, repeated qualification, ordinary
service parity, control replay and lifecycle combinations remain outstanding.
