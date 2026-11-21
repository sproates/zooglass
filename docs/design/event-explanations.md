# Explain publication decisions on the deterministic timeline

Status: accepted through PR #192, 21 November 2026. The
[production decision result](../../zooglass/docs/publication-decisions.md) is the
first implementation slice. Timeline recording and reports remain planned.

## Why this work

The timeline records what happened, but a reader still has to join actions,
receipts, state changes and deliveries by hand. Some useful reasons aren't
recorded at all. For example, one publication can be ignored by a
latest-by-sequence field but inserted into a history-by-sequence field. The receipt
records the field outcomes, but an accepted, unchanged latest field does not
itself say that the incoming sequence was older than its retained sequence.

Provide a readable explanation of publication processing, with each statement
linked to recorded evidence. ZooGlass supplies decision reasons while executing
its real strategies. Workbench presents those reasons and the recorded sequence;
it does not run a second reconciliation algorithm to infer them.

## First delivery and limits

The first delivery explains the existing static arrival/latest/history family,
including aliases, memory or SQLite storage, exact retries and controlled restart.
It retains the [static recovery bounds](../../workbench/docs/timeline-static-recovery.md):
three sources, two views, four fields in total, one source per field, envelope
entity mapping, partial publication, untracked progress and unspecified freshness.
No source-priority, required-contribution or fact-strategy explanation is claimed.
Those need their own production decision evidence, rather than generic prose
based on `changed: false`.

The user can answer:

- Which publication attempt produced this receipt, and in which runtime generation?
- Which matched fields accepted an update, ignored it, or rejected the publication?
- Was an older sequence ignored, a new contribution retained, or an existing
  publication identity intercepted before strategy evaluation?
- Did the public field change, independently of the retained contribution changing?
- Was this a new application or recognition of an existing publication identity?
- Which recorded delivery and assertion followed it, and what remains unobserved?

This is a publication explanation milestone. It does not add a browser UI,
operational logging, live-service explanation endpoint, arbitrary fault support,
performance claims, or explanations of timers, progress and fact retirement.
Restart entries identify recorded lifecycle boundaries and observations, not
internal storage-recovery steps. Existing profiles and demo behaviour are preserved.

## Current seams and proposed ownership

| Responsibility | Existing owner | Proposed change |
| --- | --- | --- |
| Update decision | `strategy/update/FieldUpdate` and concrete strategy classes | Return a closed reason with the existing update result; derive it in the branch which makes the decision |
| Matched field evaluation and visible change | `runtime/BoundView` | Collect optional, immutable field decisions; keep retained-update and public-change outcomes separate |
| Publication identity, staging and installation | `runtime/ViewCoordinator` | Return one optional explanation beside the existing outcome only after processing succeeds |
| Host effects and attempt association | Simulation host publication command path | Carry the sidecar as a distinct, versioned effect, with the command's causal association |
| Trace validation and replay | `event-schema`, `trace-contract`, `replay-document` | Validate and compare the new evidence without altering old contracts |
| Presentation | New cohesive Workbench explanation modules | Read validated evidence and render stable JSON or plain text with event references |

Use a result-returning seam, provisionally `applyExplained`, sharing the same
internal apply/stage/install path as ordinary `apply`. Reject explained processing of configurations outside the static
family before mutation; ordinary processing retains its existing coverage. Never apply first and then
re-evaluate the publication against the changed state. Return the existing
`PublicationOutcome` plus an immutable `PublicationDecision`; do not invoke an
external observer inside the transaction. Ordinary service processing does not
collect the sidecar. Existing service receipt JSON and SQLite receipt/state
schemas remain unchanged. Implementation must confirm serializer isolation before
changing result types; do not add the sidecar to an automatically serialised wire
record. A wrapper around the existing outcome is preferable.

Construct and freeze the optional result before the installation point, then
release it only after processing returns successfully. Do not add result-building
allocations or callbacks after commit. Candidate decisions remain private. A
publication rejected during staging has `installed: false` and no retained or
public changes, even if earlier fields or targets evaluated successful candidates
before a later target hit a limit. Discard those candidate details from the
installed-decision report; retain the actual rejection reason. Rejections and
duplicates describe their own completed processing path. Preserve existing
exception behaviour: an unexpected exception after installation must not be
described as rollback. A missing sidecar following an unexpected failure is not
evidence that nothing committed. Report that processing outcome as unavailable, never as rolled back.
Expiry performed before
`apply` is a separate runtime effect, never attributed to the incoming publication.

## Decision contract

Version the sidecar independently, provisionally `publication-decision/v1`.
It contains publication identity, outcome, nullable version, and ordered target /
field decisions. A field identifies its configured strategy, a closed update code,
whether its retained contribution changed, and whether its public value/provenance
changed. No payload values, wall-clock timestamps or host-generated random IDs
are added. Existing configuration and trace order determine target/field order.

Initial update codes distinguish arrival replacement, missing sequence,
latest-sequence older/equal/newer/initial, and history sequence existing/inserted.
Publication outcomes retain the runtime's existing rejection/duplicate reasons.
The contract also represents no matching target and nullable identifiers without
inventing an entity ID. Lookup-mapping failures are outside this admission family.
Final code names and nullability are frozen with the first
implementation slice and literal tests before host integration.

Distinguish strategy-unit branches from reachable publication scenarios. The
runtime supplies a validated publication sequence; missing sequence is not a V5
publication case. Equal/history-existing sequences are normally intercepted as
duplicate or identity conflict before update evaluation. Cover those branches in
strategy unit tests, without claiming that every code has a V5 publication witness.
The report describes the path actually taken, including identity interception.

Do not equate a stored update with a visible change: replacing an arrival
contribution can leave public data unchanged. Do not label every accepted input
as a winner, or every unchanging field as a rejection.

Duplicate recognition is a new attempt. Original receipt targets and their
`changedFields` describe historical processing, not new changes. The current
sidecar says the identity was already applied/committed and no publication update
was re-evaluated. It may link to original detailed evidence only when that exact
identity has a unique prior successful application in the current state lineage.
Memory restart begins a new lineage; SQLite restart preserves it. Check the
original receipt version and explicit lifecycle/attempt edges as well as identity.
The same identity and version can recur after memory restart, so neither alone
is sufficient. Missing or ambiguous links report original detail unavailable.
After restart or retention gaps, the original detail can also be unavailable. Do not persist new explanation data merely
to fill that gap, and do not confuse publication identity with connection generation.

## Evidence compatibility and causality

Detailed explanation recording is explicit. Add V5 scenario/trace/run/bundle
identities and a host `publicationDecisions:1` capability while retaining the
`static-views-restart-v1` configuration profile and its existing admission rules.
V5 requires exactly one decision sidecar for each normally returned publication
outcome, including semantic rejection and duplicate recognition. An explicitly
recorded failed command may have unavailable detail; a missing sidecar for a
successfully completed command is invalid evidence. V4 remains unchanged. Do not create a second configuration profile just for diagnostics,
silently insert events into V1–V4, or reinterpret their hashes. Unsupported hosts
fail before execution.
Existing converter output remains V3; no automatic format upgrade is introduced.

A decision references the processing command and its source attempt. A receipt
being produced is distinct from its delivery to a source. Parent/causes edges are
recorded execution relationships, not proof of a business-level cause. Correlate
through explicit IDs and generation-aware identities, never timestamp adjacency.
One publication may have several target decisions, deliveries or assertions.
Report their real cardinality rather than selecting the nearest event.

Replay re-executes and compares decision records as part of the semantic trace.
A changed reason must cause divergence even when final values happen to match.
The explanation is a derived report, outside the bundle and outside replay
identity. Old bundles remain readable; their reports explicitly state that detailed
runtime reasons were not recorded. Unsupported explanation families receive
observed-outcome summaries only, not static-strategy interpretations.

## Reader interface

Proposed command:

```sh
npm run timeline:explain -- BUNDLE REPORT --format text|json [--event EVENT_ID]
```

Read a complete bundle through the existing bounded `readBundle` / `parseReplay`
validation path. Do not launch Java, require installed runtime artifacts, contact
the network, or change evidence. Reject incomplete, invalid or unsupported evidence
rather than salvage a convincing-looking explanation from a partial trace.

JSON has its own version, input manifest/trace hashes, recorded profile and outcome,
`replayStatus: not-run`, coverage, entries and explicit missing-detail notes. Entries
contain event references, virtual time, runtime/connection generation where present,
publication identity, evidence-derived codes and a human-readable explanation.
Text renders the same model. Output ordering and bytes are stable for the same
input and report version; no current timestamp or absolute machine path is emitted.

`--event` selects an existing event and its explicitly linked explanation context;
unknown IDs fail. Output must be a new file outside the evidence directory,
including resolved symlink parents. Bound report bytes and entries, with explicit
failure instead of silent truncation. Escape control characters in terminal text;
never treat identifiers or payload strings as executable markup or terminal codes.
No raw payload values are rendered in this first version. Identifiers can still
be sensitive, so the report is not advertised as anonymised or safe to publish.

Exit 0 means a report was generated for a recorded passed scenario; 2 means a
report was generated for a recorded failed/limited scenario; 1 means invalid input,
unsupported report format, bounds or I/O failure. Successful parsing verifies
internal consistency, not provenance authenticity or fresh runtime replay.

## Delivery sequence and acceptance

Three implementation PRs follow design acceptance, each reviewed independently.
No new scenario capability is bundled into this work.

1. **Production decision result.** Implement the shared explained/ordinary path and
   closed static update reasons, with optional collection at publication scope.
   Literal tests cover every branch, aliases/multiple targets, equal public data,
   rejection after earlier staged candidates, duplicate and install failure. Test
   an exception after installation without claiming rollback. Compare ordinary and explained paths
   for identical receipts, installed state and delivery effects. No sidecar data
   enters service JSON or durable storage. Update production source diagrams.
2. **Versioned timeline evidence and report.** Add the explicit host capability,
   trace/run/bundle identities and strict decision validation. Deliver
   the offline CLI and stable JSON/text output together. Exercise causal joins,
   generation boundaries, memory restart/reapply/retry lineage (including a negative
   join to the earlier lifetime), reason-only replay divergence and unchanged V1–V4
   parsing/replay. Keep model, joins, renderers and CLI ownership separate; do not
   expand the existing execution or bundle modules into presentation engines.
3. **Qualification and guides.** Freeze a finite coverage table before execution:
   memory mixed-strategy fixture, SQLite restart/duplicate fixture, rejected input,
   assertion failure, older evidence without detail, and deliberately wrong reason.
   Use independent expected statements and event references, not snapshots produced
   by the renderer under test. Require normal/paused semantic equality and strict
   replay for both new successful fixtures, plus a reason mutant which fails the
   expected reason despite unchanged state. Check invalid hashes, recomputed
   inconsistent evidence, missing/multiple associations, output containment and
   limits. Publish exact counts and limits, examples, capability matrix and source
   maps. Prepare JARs separately; tests never initiate builds.

The finish line is a user-facing command which explains supported publication
choices accurately, cites evidence and says when a reason is unavailable, backed
by production branch tests, unchanged ordinary behaviour and deterministic replay.
Broader strategy explanations are future work, not an open-ended acceptance gate.
