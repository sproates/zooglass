# Order and Sports timeline assessment

At the assessment baseline, neither completed demo configuration was admitted by
the deterministic simulator. The runtime already implements their strategies; the missing work is
controlled execution of additional combinations and control endpoints, with
independent evidence. This assessment defines the next bounded extensions. It
does not convert the legacy JSON format. The subsequent
[Order host foundation](timeline-order-host.md) admits the bounded Order configuration
and progress endpoint; document execution and qualification remain outstanding.

## Baseline and observed admission

The simulator baseline is `abca662`. The completed demos are assessed at main
commit [`ad04db9`](https://github.com/sproates/zooglass/tree/ad04db982cf32e4f26919a7ffbbb042e48212a78/workbench/src/demos).
That distinction matters: this POC branch contains an earlier Order producer and
no completed Sports producer. The old `order-fulfilment-live-order.json` and
`sports-betting-live-market.json` are not substitutes for the delivered demos.
Future fixtures should retain the pinned schedules' inputs and meaningful
checkpoints, with their own explicit virtual-time adaptation. Do not merge all of
main merely to obtain a fixture.

There are no production `zooglass/` changes between the branches' common ancestor
`1ba9c57` and this pinned main commit. A direct POC-to-main diff would instead
remove the POC's controlled-clock/delivery seams. Preserve those seams; selectively
adapt the required configuration/input definitions with source provenance.

Sources assessed at that commit:

- Order: `orders/configuration.ts`, `contracts.ts`, `timeline.ts`,
  `source-session.ts`, `progress.ts`, `checkpoints.ts`, `run.ts` and `recovery.ts`.
- Sports: `sports/configuration.ts`, `timeline.ts`, `source-session.ts`,
  `receipts.ts`, `checkpoints.ts` and `run.ts`.

On 14 November 2026, configuration-only probes using the prepared simulation host
accepted both configurations' production syntax but returned `unsupported`.
Copies with memory storage and the three top-level resource limits reduced to 20
also returned `unsupported`. All four probes produced no effects, pending tasks
or held frames; no runtime/store was initialized and no Java build ran. The
reduced copies are diagnostic probes, not proposed equivalent configurations.

The exported configuration bytes (two-space JSON plus newline) have SHA-256:

| Input         | SHA-256                                                            |
| ------------- | ------------------------------------------------------------------ |
| Order         | `d3398885305dc27c409ad3cea3f9035d7c024e572ee2ee16354421a74fad1a33` |
| Sports        | `775781cbf4e64abfb9a4a7ea1c61f8e7f904d3e743f5e8e660bec536e9e367ae` |
| Prepared host | `69574582706fdf7fbff56d176974a79a7ee71f237735bfec04a9b5224a5165f0` |

## Capability gap

| Behaviour        | Delivered Order                                                | Delivered Sports                                                    | Timeline position                                                                                                        |
| ---------------- | -------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Shape            | Five sources, two views, seven field definitions, six orders   | Two sources, three views, fourteen field definitions, three matches | Fleet admits two sources/two views/three fields; larger shapes need explicit profiles and ordering checks                |
| Persistence      | SQLite, durable receipts and recovery checkpoint               | SQLite, durable receipts and retained fact windows                  | SQLite restart exists for one arrival/receipt-age field; these combinations are unqualified                              |
| Updates          | Latest by sequence on all fields                               | Latest match/market plus active facts and summed facts              | Sequence execution exists; fact strategies are excluded by profile admission                                             |
| Entity mapping   | Source-specific lookup keys except order IDs                   | Envelope entity IDs                                                 | Only envelope mapping is admitted                                                                                        |
| Source selection | Primary courier before backup                                  | One source per field                                                | Multiple inputs and priority are excluded                                                                                |
| Publication      | Partial summary; tracking waits for order and inventory        | Partial views, including absent score fields before baselines       | Required contributions are excluded                                                                                      |
| Freshness        | Inventory and delivery expire after 15 seconds                 | Market expires after 15 seconds                                     | Receipt-age execution exists separately; combination with sequence/priority/facts needs proof                            |
| Progress         | Three tracked sources; couriers untracked; explicit watermarks | Both sources tracked; bookmaker watermarks                          | Profiles admit untracked progress only; no modeled progress endpoint                                                     |
| Fact lifecycle   | None                                                           | Create/revise/retract, first-fact comparison, per-view retirement   | Full publication JSON can carry fact metadata, but profiles reject these strategies and no retirement endpoint exists    |
| Observation      | Receipts, two views, status/provenance, recovery               | Receipts, three views, scores/lists, progress/floors                | Complete snapshots already represent progress and fact status; control acknowledgements need explicit evidence contracts |

Order's production bounds are 64 streams, 128 identities per stream, 64 history
entries and 64 received/missing ranges; 30 normal streams plus one diagnostic
stream are used. Tracking permits six pending entities. Sports uses 16 streams,
128 identities, 64 history entries, 16 progress ranges and 16 retained facts per
fact field, across six streams. Preserve these bounded configurations for parity.
Lowering identity/fact limits changes admission floors, duplicate behavior and
retirement outcomes, even when a final visible score looks the same.

## Shared control transport

Add narrowly typed progress and fact-retirement control sessions/actions rather
than sending controls through the publication endpoint. Model their request and
response links, connection generations, pending work and cancellation explicitly.
The host must invoke production `ProgressIngress` and `FactRetirementIngress`,
which use `ViewCoordinator.advance` and `retire`. It must not reproduce their
state transitions in TypeScript or bypass the production parser.

Controls need complete acknowledgement assertions and causal trace records, bound
to the actor, endpoint, request and runtime generation. Preserve status, reason,
version, changed views and returned floors. A retirement affects one view
atomically; three successful view controls are not a cross-view transaction.
Check SQLite health after control dispatch: production handlers can turn caught
exceptions into `failed/processingFailure`, which cannot qualify as a semantic
success or an intended negative control.

Introduce explicit host capabilities and profile agreement. Update document
admission, transport, trace validation, retained evidence, replay and bundles
as one contract. Old hosts/evidence must fail clearly when the new capability is
required; do not relabel old evidence. Reuse existing actor/task ownership and
real handlers through cohesive modules, without growing a second executor or a
generic endpoint/plugin framework. Keep existing profiles' guarantees unchanged.

Start with delivery and explicit exact repeats. Control acknowledgement loss and
bounded retries require their own rules: watermark duplicate handling and equal
retirement floors are not publication identity receipts. Test those production
outcomes before adding retry automation. Suppressed acknowledgements must not
undo committed progress or retirement. Restart must invalidate old sessions and
queued replies while retaining committed state.

## Order first

Use a separately identified bounded SQLite Order profile retaining the accepted
configuration. Initially qualify ordinary execution; do not infer restart or wall
adjustment support from the older SQLite profile. Reject unqualified lifecycle
combinations explicitly until their separate tests pass.

The authored fixture must preserve these distinctions:

- Lookup joins different source entity IDs; the unmapped payment is durably
  committed but has a rejected summary target with a null entity ID.
- Backup contributes before primary. A stale primary remains authoritative even
  after a fresh backup update; cross-source sequence numbers are not compared.
- Tracking waits for its first order and inventory contributions. The gate does
  not reset each synthetic cycle and is not an atomic multi-source transaction.
- An out-of-order publication closes a provisional progress gap without replacing
  a newer field value. Watermarks confirm omitted payment evidence; exact retries
  return durable duplicate receipts without applying again.
- Virtual silence crosses the actual 15-second receipt-age deadline. Reconnect
  alone does not refresh a value; accepted inventory/courier input does. Include
  just-before, at-deadline and same-time input cases, preserving expiry-before-input.
- A second cycle exposes mixed old/new contributions and the previous-cycle retry.
  A later bounded retention case crosses the identity window; a short two-cycle
  fixture alone cannot claim the existing 50-cycle retention evidence.

Fix Order's epoch and tick duration explicitly when adapting its schedule; its
convenience `orderTimeline()` default uses `Date.now()`. Replace real polling and
waits with declared virtual actions and settled observations. Preserve ordering
within a tick: source receipt barriers in the real producer are not equivalent
to a simultaneous burst. Verify a separate same-time multi-source/two-client
case instead of silently changing the checkpoint semantics.

Then add a bounded Order recovery fixture: reopen the same SQLite store, inspect
installed views/progress/candidates, obtain fresh viewer baselines, retry an exact
committed publication and admit the next identity. Include generation cancellation
and freshness continuity. Protected HTTPS/browser behavior remains real-service
evidence; it is not part of this unprotected deterministic profile.

## Sports follows Order

Use a separately identified SQLite Sports profile, reusing the qualified progress
transport. Admit only the needed `activeFacts`/`sumActiveFacts` combinations,
`firstFact`/`latestFactRevision` policies, envelope entities and `points` projection.
Do not claim arbitrary aggregations or mapped fact-retirement support.

Author at least two cycles with literal scores, complete collections, receipt
outcomes, statuses and floors. Preserve absent scores before kickoff baselines,
a valid zero after all goals are withdrawn, and empty retired windows before new
baselines. These are different states even when the displayed number is zero.

A correction before create must reject as `unknownFact`, yet the same correction
can succeed after the delayed create. In the first cycle, the unknown-fact
rejection leaves match progress observed through 4; rejected fact targets on later
admitted publications can still accompany durable commitment and progress
advancement. Withdrawal and older revision outcomes must
differ between corrected and first-reported views. Retiring each view must expose
its actual intermediate state; a partial failure stops further cycle publication
without rolling back views that already committed. Equal-floor retry, lost
acknowledgement, retained old duplicate and new correction to a retired birth all
need independently expected outcomes. Check fact/progress retention separately
from the first two cycles, including tombstones and bounded receipts.

Sports currently embeds `Date.now()` in match and market payloads. The adaptation
must use explicit authored timestamps or a supplied deterministic clock before
serializing the scenario. Do not erase those fields from comparisons or generate
expected scores by running the strategies. Preserve `basedOnMatchSequence`,
progress and cycle relationships independently of receipt-age freshness.

## What parity can honestly compare

Unlike fleet's unspecified freshness, these demos retain real receipt-age
samples. Ordinary service receipt timestamps and deadlines come from its real
clock. Its expiry timing can also affect global version allocation and socket
frame order. Do not demand byte-identical ordinary-service and virtual traces.

Author a narrow common comparison contract before running either path: business
values, selected source provenance, publication identities, target dispositions,
progress gaps/watermarks, fact floors and publication readiness at named barriers.
Compare receipt versions relationally where appropriate (an exact retry retains
its original committed version), rather than equating independently timed global
version numbers. Record every excluded clock/version-dependent field and why;
retain full raw observations so the projection is auditable.

In the controlled run, continue asserting complete literal timestamps, deadlines,
versions and trace order. In the ordinary service, separately prove freshness
transitions around observed real deadlines: fresh input, eventual expiry, no
refresh on reconnect or non-selected backup input, then refresh on accepted
selected input. Use state/receipt barriers with bounded deadline waits. Neither
path may hide a wrong freshness state by excluding all status from comparison.

Current injected host pauses are capped at 250 ms, below these configurations'
15,000 ms stale interval. A 70/90 ms pause campaign therefore does not establish
threshold-crossing sensitivity by itself. Add near-deadline virtual cases and a
targeted incorrect-clock control whose intended assertion fails, or separately
justify a bounded longer-pause probe. Keep the production freshness configuration
unchanged and distinguish this evidence from wrong-priority/revision controls.

## Delivery gates

1. **Order host and progress transport.** Bounded profile, real control handler,
   complete control evidence and replay; boundary/invalid control checks and
   same-time ordering with multiple clients. Keep SQLite health failures distinct.
2. **Order scenario and lifecycle.** Independent expectations before execution;
   separate ordinary and recovery cases, with clearly stated supported combinations.
3. **Order qualification.** Bounded fresh-process campaign with long Node/JVM
   pauses, a deliberate wrong-priority or wrong-gate runtime control, strict replay
   and ordinary WebSocket/HTTP parity using the identical configuration. Retain raw
   evidence and publish hashes after independent audit.
4. **Sports host and retirement.** Explicit fact profile and retirement control
   ownership/evidence; atomic per-view failure and retry checks, fact-field ordering
   and numeric sum boundaries. Preserve Order and earlier evidence contracts.
5. **Sports scenarios and qualification.** Two-cycle facts/baseline/retirement
   fixture, separate retention case, targeted wrong-revision-policy control, exact
   repeatability/replay and ordinary-service parity. Broader restart combinations
   remain separately gated rather than inferred from SQLite storage.

Before implementing each fixture, count turns, actors, connection generations,
observations and trace bytes. Current execution permits ten actors, ten total
connection generations, 2,000 turns and 16 MiB traces. Order recovery reconnecting
all sources/control/viewer can exceed the connection budget; Sports' real short
control sockets cannot be copied indefinitely. Split coherent cases or justify a
small profile-specific bound with rejection tests. Never truncate evidence or
silently relax every profile. Do not repeat cumulative full-frame expectations
at every input when a bounded independent checkpoint proves the intended contract.

Audit all newly observable ordering before widening admission: mapping/candidate
iteration, simultaneous freshness deadlines, progress-driven view effects, fact
collections/sums, retirement field lists and client dispatch. Canonical object-key
encoding cannot repair a different array order or version assignment. Keep the
current policy that expiry precedes same-time input; explicitly specify where
controls sit relative to inputs, writers and restart. Repeated runs are evidence
for defined rules, not a way to choose the rules accidentally.

Each stage requires focused checks and independent review before proceeding.
Tests consume prepared JARs; preparation is explicit. Reuse qualification tools
where their contracts fit, but do not multiply nominal seeds into claims of
additional behaviors. No generic JSON converter, DSL, browser migration, transport
security simulation or promotion of this POC to main is included.
