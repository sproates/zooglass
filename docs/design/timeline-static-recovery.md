# Reusable static-view recovery on the deterministic timeline

Status: proposed, 21 November 2026. This is a design for the next bounded
expansion, not a claim of delivered support. The [current capability guide](../../workbench/docs/timeline-guide.md)
remains authoritative until implementation and qualification are complete.

## Outcome and finish line

Run user-defined mixtures of arrival, latest-by-sequence and history fields with
memory or SQLite storage, stop and restart the runtime, and verify the resulting
state and publication receipts. Use the same deterministic scheduling, real
production strategies and replay checks as existing timeline scenarios.

For example, a scenario can retain the latest temperature and its recent history,
restart, reconnect a viewer and retry an earlier publication. With memory storage,
the restarted runtime starts empty and processes that publication again. With
SQLite, it restores durable state and recognises a retained exact duplicate.
Those are different expected outcomes, both reproducible and independently tested.

Finish when the configuration/action matrix below executes, strict replay verifies
its evidence, and the fixed qualification cases pass. This is one reusable
recovery family, not a programme to admit every ZooGlass configuration. Further
strategy combinations, faults and larger limits require separate scope decisions.

## Why this combination

The delivered static-view family supports custom mixtures and aliases but only
memory storage and a single runtime generation. Lifecycle ownership and SQLite
recovery already exist in narrower arrival and Order families. Combining these
boundaries offers reusable recovery checks without introducing a new strategy,
network model or orchestration engine.

The current code makes the restrictions explicit:

- `StaticViewsTimelineProfile` validates shape, policies and memory storage.
- `static-contract.ts` closes V3 to zero-latency, single-generation actions.
- `TimelineHost.initializeDocument` requires generation one for static views;
  requested admission avoids changing legacy first-match classification.
- `RuntimeGenerations`, `RuntimeTurns` and `DocumentTransport` already own fresh
  host processes, virtual clocks, stopped-runtime observations, task cancellation
  and connection generations. `RunStore` owns the private SQLite path.
- Public data projections already use production `ViewSnapshot.from`, alongside
  retained full snapshots. Replay and bundles already re-execute and check inputs.

Reuse those responsibilities. Generalise only the explicit profile gates needed
for this family; do not scatter new storage-specific reconciliation into Workbench.

## Configuration contract

Proposed requested profile: `static-views-restart-v1`. Storage is explicit in both
runtime configuration and scenario, and must agree. The family admits both modes;
it does not infer durability from the presence of a database path.

| Dimension           | Admitted boundary                                                                 |
| ------------------- | --------------------------------------------------------------------------------- |
| Runtime             | Production configuration version 2, unprotected access, static definitions        |
| Storage             | `memory` or `sqlite`; unchanged exact configuration bytes across generations      |
| Shape               | 1–3 sources, 1–2 views, 1–3 fields per view, at most 4 fields total               |
| Field strategies    | `arrival`, `latestBySequence`, `historyBySequence`, including mixtures            |
| Inputs              | One source per field; one or two distinct event types from that source            |
| Mapping/publication | `envelopeEntity`, `publishPartial`                                                |
| Freshness/progress  | `unspecified`, `untracked`                                                        |
| Other policies      | `acceptLate`; no conflict policy, facts or property aggregation                   |
| Resource ceilings   | 20 streams, identity window 20, history entries 20; delivery 128 messages / 1 MiB |

These are the existing static family's bounds, not production limits. Retain
existing document, publication, actor, connection, generation, turn and trace
budgets rather than raising them to accommodate fixtures. A configuration fitting
this shape can still exceed execution budgets; report that distinctly from an
invalid configuration, unsupported profile or failed semantic assertion.

Production parsing and defaults remain authoritative. Inspect the requested family
without constructing a runtime or opening a scenario database. Startup repeats
admission against the actual configuration bytes. Preserve legacy classification,
V1–V3 admission results and all delivered profile meanings. A shared, narrowly
named predicate may own common static-field rules; each profile owns its storage
and lifecycle restrictions. Do not introduce a plugin or arbitrary capability registry.

## Actions, assertions and recovery semantics

| Area             | Contract                                                                                                             |
| ---------------- | -------------------------------------------------------------------------------------------------------------------- |
| Time             | Existing global virtual timeline and phase/ordinal ordering; no wall-clock adjustment                                |
| Links            | Zero latency; declared sends and client operations only                                                              |
| Connections      | Explicit source/client connect and disconnect; explicit reconnect after restart                                      |
| Views            | Client subscribe/unsubscribe; subscriptions are not restored automatically                                           |
| Publications     | `source-send` and explicit `source-retry` of the same declared publication by the same actor                         |
| Lifecycle        | `service-stop` with `orderly` or `abrupt`, then `service-start`; between acknowledged turns only                     |
| Assertions       | Existing full runtime snapshots, receipts and client frames, plus public-data and source-acceptance projections      |
| Excluded actions | Automatic retry policies, receipt-loss rules, writer faults, progress/retirement controls, dynamic view registration |

A stop invalidates runtime-owned tasks, sessions and subscriptions. A fresh host
process owns each restart. Actor publication history stays with the scenario,
allowing an explicit retry after a new connection; no old session or frame may
leak into a new generation. Existing phase ordering applies even when stop,
start and connection actions share a timestamp. No hidden drain step, invented
millisecond or implicit reconnect may change the declared scenario.

Virtual time continues across downtime. Generation-local monotonic time starts at
zero; receipt wall time remains epoch plus global virtual time. Host pacing and
SQLite I/O duration are not semantic time. Timeouts are infrastructure failures,
not alternative runtime outcomes. Reuse the existing unavailable-observation contract
for runtime snapshots. Reject sends and retries while stopped
or without an explicit live connection; no automatic reconnect is implied.

Memory restart loses installed values and publication identities. SQLite restart
uses the same run-private database and restores the production durable state.
The first generation requires a new database path; subsequent generations require
the same existing regular file. No user-supplied database, imported store or
configuration mutation is admitted. Each independent run and replay begins with
its own empty store. A saved database must never substitute for re-executing the
publications that created it. Preserve current cleanup and failed-run diagnostics.

An explicit retry references the original publication declaration, preserving its
complete identity and content. After SQLite restart, retained exact duplicates
must return the production duplicate receipt, including its original version and
target results, without a new effect. Memory reapplication must be checked against
an independently authored expected receipt and state. Retained conflicting content
and identities below the retention floor are separately asserted rejections;
they must not be accepted merely because the final data happens to match.

Full-envelope assertions prove recovery, versions and duplicate/rejection semantics.
`source-accepted` remains a broad acceptance projection bound to a `source-send`;
V4 requires that send to be the actor's sole publication attempt at its timestamp,
counting both `source-send` and `source-retry` when checking uniqueness. Reject
ambiguous send-plus-retry checkpoints at admission. Do not use this projection to
prove retries or rejections, or change V3's existing contract.
Use full receipt assertions for `source-retry`. Public-data assertions remain
non-null object comparisons requiring an available runtime. Full runtime observations cover empty/absent data and
unavailable runtime states using their existing contracts. Keep cumulative frame
and receipt histories unchanged and generation-labelled; no consuming-client
assertion model is added.

## Identity, authoring and compatibility

Use a new explicit document/evidence generation: `timeline-simulation/v4`,
`timeline-trace/v4`, `timeline-run/v4` and `timeline-bundle/v4`, with the new profile.
Keep host protocol 2 and advertise a separate `staticViewsRestart:1` capability
only when the complete host contract is implemented. Require public
snapshot support for both storage modes, and additionally require native SQLite
and lifecycle identity when storage is SQLite. An older
host must reject the request clearly before runtime effects.

V4 is a closed contract, not permission to combine all V2 and V3 actions. Readers
validate the profile, storage, actions, assertions and generation transitions.
Update execute, admission inspection, trace/run validation, record, bundle, replay
and compare together; no command may silently downgrade the evidence version.
Tampered generation, storage, profile, projection or identity metadata must fail.

Author scenarios explicitly. Ordinary runtime JSON remains the input; configuration
templates must first be expanded using the delivered authoring command. Do not
change the legacy converter, its five accepted fixtures, or conversion provenance.
V4 excludes `conversionReport`; accepting a converted V3 document as V4 merely by
changing its version string would misrepresent the conversion contract.

Old evidence remains immutable and replayable with its original tools and recorded
environment. Newly built tools retain old syntax support, not cross-version replay
identity. Comparisons between different formats or execution identities remain
incompatible. Bundles retain exact inputs and evidence, not executable dependencies.

## Ownership and implementation discipline

| Responsibility                        | Existing owner / intended change                                                                                     |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Shared static configuration rules     | `StaticViewsTimelineProfile` with a cohesive shared predicate if needed; new profile owns recovery admission         |
| Requested inspection and host startup | `RequestedProfileAdmission`, `TimelineHost`, `HostProtocol`; explicit new capability/profile                         |
| Document/evidence contract            | `evidence-versions.ts`, `contract.ts`, a focused recovery-family validator; keep V3 validator closed                 |
| Processes, clocks, stores             | `RuntimeGenerations`, `RunStore`, existing bridge lifecycle; no second lifecycle engine                              |
| Task and connection invalidation      | `RuntimeTurns`, `DocumentTransport`, existing agenda/generation validation                                           |
| Observations and replay               | Existing production projection, trace validation, bundle and replay modules                                          |
| Qualification                         | One small scenario-matrix runner using existing evidence helpers; no per-domain runner or general campaign framework |

Update the source maps when ownership changes. Refactor an affected responsibility
if necessary for clarity, but do not turn the milestone into a general cleanup.
Production persistence and reconciliation remain production code. Any discovered
production defect needs a fail-before/pass-after regression and explicit review;
it is not a reason to emulate the corrected answer in the simulator.

## Fixed qualification matrix

Freeze literal expected receipts, installed/public snapshots, client frames and
versions before executing the candidate. Use domain-neutral names and arbitrary
valid identifiers, not demo-name allowlists. Every case has a finite horizon and
ends without pending tasks, messages or held frames.

| Case | Storage / stop        | Independent witness                                                                                                                                    |
| ---- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| M1   | Memory / orderly      | Mixed arrival/latest/history, aliases and two entities; empty restart, explicit reconnect/resubscribe and reapplication                                |
| M2   | Memory / abrupt       | Same strategy mixture, stop/start at one timestamp; generation isolation and new-generation state                                                      |
| S1   | SQLite / orderly      | Mixed fields and two views; initial recovered snapshots before new input, then exact duplicate with original receipt                                   |
| S2   | SQLite / abrupt       | Same durable contract after process termination between turns; new out-of-order input changes arrival/history but not latest                           |
| S3   | SQLite / two restarts | One orderly and one abrupt stop; retained exact identity, conflicting identity, inclusive retention floor and below-floor rejection across generations |
| B1   | Memory / no restart   | Maximum admitted shape: three sources, two views, four fields; distinct aliases and shared source sequence across entities                             |

Run each case once normally and once with measured long Node/JVM pauses during
real semantic work; strictly replay each run. Require exact canonical semantic-trace equality between
the normal and paused recordings of each case, excluding only existing nonsemantic
diagnostics. Replaying two individually consistent but different traces does not
establish pause invariance. That is **24 scenario executions**,
with no seed multiplier because this family has no random faults. Require pause
evidence in the initial and restarted generations, including state-effect and
writer-handoff sites where exercised. Do not demand alarm evidence when no alarms
are scheduled. Assert virtual clock values independently at the relevant turns.

Add one isolated wrong-recovery control: deliberately clear durable state on
restart while leaving protocol identity/generation metadata valid. The normal
host must pass S1; the mutant must reach and fail the named restored-state assertion.
A startup error, artifact mismatch or missing evidence does not count as detection.
Prepare the control artifact explicitly and retain its recipe/hash. Two executions.

Run two ordinary-service comparisons, M1 and S2, with exact configuration/input
bytes and the same independently authored expected outcomes. Compare state,
receipts and a reconnect snapshot at explicit barriers; do not require real socket
traces to equal the virtual trace. Two executions. Total fixed qualification:
**28 executions**, excluding focused tests and CI, not a count of OS processes.

Focused tests additionally cover each excluded dimension, every numeric boundary,
legacy profile overlaps, storage disagreement, missing capabilities, runtime-down
assertions, invalid lifecycle order, source-retry without prior send, stale session
or task ownership, malformed/tampered evidence, failed startup and cleanup, and
fresh-store replay isolation. These are contract tests, not new campaign slices.

Retain raw evidence once, audit its completeness and independent expectations, and
publish an immutable release asset with a committed hash/source/environment manifest.
Verify the downloaded archive. Qualify the recorded macOS arm64 environment only;
Linux expansion and cross-platform equality are not required for this milestone.
Tests and qualification consume explicitly prepared JARs and never trigger builds.

## Delivery and acceptance

Use normal branches and PRs from current main. No integration branch or automatic
merge permission is assumed. Each functional delivery must be independently
reviewable, tested and usable; do not expose partially supported capabilities.

Proposed sequence, subject to design review:

1. **Design contract.** Review this matrix, identity, ownership and finite evidence
   plan. Implementation starts only after design acceptance.
2. **Complete recovery family.** Host admission, V4 lifecycle execution, memory and
   SQLite, assertions, inspection, record/replay/bundles, focused tests and the six
   reviewed fixtures. Preserve all existing profile behaviour and selected CI.
3. **Qualification and closeout.** Execute the fixed matrix and detection/service
   controls, publish/audit evidence, update the capability guide, READMEs, source
   maps and roadmap with the demonstrated scope.

This is **one design PR and two implementation/evidence PRs**, not a promise to
compress an unreviewable change. If the feature PR needs separation, first propose
one behaviour-preserving prerequisite extraction; do not silently add capabilities
or an indefinite list of slices. New claims stay marked unqualified until step 3.

Completion requires zero actionable review findings, passing focused and applicable
CI checks, strict replay and audited evidence for every matrix row, clear admission
errors, usable examples and current documentation. No additional profile, automatic
legacy migration, transport fault, UI, DSL, performance claim or distributed-runtime
support is part of this milestone.
