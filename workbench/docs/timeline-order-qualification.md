# Order qualification

This gate checks the existing [ordinary](timeline-order-scenario.md),
[recovery](timeline-order-recovery.md) and [retention](timeline-order-retention.md)
fixtures. It adds qualification tooling and evidence, not another Order profile.
The exact five-source SQLite configuration remains unchanged.

## Finite campaign

Five groups each run in three fresh Node/JVM executions: a baseline, then the two
existing timing-perturbation modes. The resulting 15-run matrix has no redundant
seed dimension: these scenarios contain no seeded fault rules. Its claims build
on the earlier core/lifecycle qualification, not a new 100-run-per-scenario claim.

The checker requires every complete authored assertion, exact per-group traces,
expected receipts/frames and observed Node/JVM pauses in each applicable generation.
Ordinary Order uses `sqlite-order-v1`; recovery/retention use the explicit restart
profile. Only that executor identity differs across groups; other environment
fields must match. Within a group, every execution/environment identity matches.

The Order runner allows 120 seconds per child. Ordinary Order has 580 host commands;
70–90 ms of deliberate delay per command alone exceeds the shared 30-second default.
This is a bounded infrastructure timeout, never semantic time. Other campaigns
retain their existing 20-run and 30-second defaults.

From `workbench/`, with the normal host already prepared:

```sh
npm run timeline:order-repeat -- /tmp/order-smoke ../zooglass/simulation-host/target/zooglass-simulation.jar 2
npm run timeline:order-repeat -- /tmp/order-qualified ../zooglass/simulation-host/target/zooglass-simulation.jar 3
```

Use new output directories. The two-run-per-group smoke checks tooling; only the
three-run matrix from a clean committed checkout qualifies. Tests and campaigns
never build Java.

## Actual incorrect-runtime controls

Two mutations test whether the unchanged recovery-after oracle detects wrong
runtime behaviour. One reverses production `SourcePriority` selection. The other
incorrectly resets wall time to epoch plus generation-local monotonic time.
The first must fail the 47 ms snapshot with backup rather than primary provenance;
the second must fail the installed recovery snapshot at 15,023 ms with `ageUnknown`
rather than stale receipt age. Startup/provenance failure is not a successful control.

Preparation explicitly builds isolated normal and mutated artifacts from committed
Java sources. It validates source changes, embedded runtime identity and actual
class-level JAR differences. Execution rechecks those bytes and binds each run to
its prepared artifact, configuration, profile and executor hashes. The normal run
must pass; each mutant must fail identically with and without measured pauses.

```sh
npm run prepare:order-controls -- /tmp/order-controls-prepared
npm run timeline:order-controls -- /tmp/order-controls-prepared /tmp/order-controls
```

Preparation is separate from execution and uses an isolated Maven repository. It
does not replace the normal prepared service/host. This generation-clock mutation,
combined with the existing before/at/after deadline cases, checks clock continuity.
The 70/90 ms host pauses do not themselves cross Order's 15-second freshness threshold.

## Ordinary-service comparison

The parity runner uses the prepared service JAR, actual source/progress/client
sockets, HTTP observations and a caller-owned temporary SQLite database. It checks
mapping, an unmapped payment, required contributions, source priority, progress
repair/watermarks, duplicate identity and actual freshness transitions.

Common projections exclude only top-level versions and field receipt timestamps;
they retain payload timestamps, provenance, readiness, freshness, gaps, floors and
receipt targets. Raw observations retain excluded fields. Duplicate receipts must
keep their original durable version. Per-subscription barriers avoid inventing a
global cross-socket frame order.

No HTTP snapshot reads occur during the expiry wait. The runner first observes
spontaneous client stale frames at or after the original 15-second deadlines,
then compares HTTP state. Reconnection and a fresh backup must not refresh the
selected primary; an accepted primary refresh must. Temporary service/store cleanup
runs even after a failed assertion.

```sh
npm run timeline:order-service-parity -- /tmp/order-parity ../zooglass qualification
```

This is selected contract parity, not byte-identical real-time and virtual traces,
full browser testing or the original demo's 50-cycle resource run.

## Acceptance and limits

Qualification requires reviewed committed tooling, the finite campaign, both
runtime controls, real-service parity, strict replay and one independent raw-evidence
audit. Raw artifacts are retained outside Git; release asset hashes belong in the
[evidence manifest](../evidence/README.md). Native environment identity and measured
counts are recorded with the results; no cross-platform equality is inferred.

## Recorded results

The clean campaign at `e577289` passed all 15 fresh executions on macOS arm64.
Across five groups it checked 855 authored assertions and 13,461 trace records,
with exact per-group trace equality. The ten perturbed executions recorded
2,884 Node command pauses and 38 JVM pauses. No seed dimension was added.

Both actual incorrect-runtime controls failed the intended assertions, identically
with and without pauses; the isolated normal runtime passed. The ordinary service
comparison passed 18 barriers and four spontaneous expiry observations. All 204
production classes matched byte-for-byte between the service, simulation runtime
and isolated normal control runtime.

Strict replay verified all five baseline traces (1,908, 649, 649, 865 and 416 records)
and a fresh 1,908-record portable bundle. Focused shared/service/control regressions,
Order campaign checks, type checking, lint and formatting passed.

The preliminary smoke exposed two checker metadata errors: recovery command
counts included a request cancelled before host ingress, and the ordinary case
omitted its first alarm-dispatch pause at 24,010 ms. Corrected checks and focused
regressions passed before the clean campaign. Scenario expectations and runtime
semantics were unchanged.

Independent raw-evidence audit passed, including exact identities, complete
assertions, pause evidence, mutation deltas, service observations and replay.
The [retained archive](../evidence/README.md) includes the audit script/report and
all qualification runs. Prepared executable artifacts and diagnostic SQLite
stores remain outside the archive; hashes do not make it a runnable environment.
