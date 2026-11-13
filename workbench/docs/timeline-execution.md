# Bounded deterministic document execution

The POC executes `timeline-simulation/v1` documents against the real configured
ZooGlass runtime. The qualified profile is `memory-arrival-v1`; this is not yet
a general simulator, automatic legacy conversion or a replacement for socket tests.

From `workbench/`, explicitly prepare the JAR once, then run:

```sh
npm run prepare:timeline
npm run timeline:execute -- scenarios/simulation/warehouse-retry.json /tmp/warehouse-run.json
npm run test:timeline
```

Execution and tests never build Java. An optional third execution argument selects
a prepared JAR. The output contains the canonical scenario, exact configuration
text, artifact/configuration/Workbench hashes, semantic JSONL trace and outcome.
A failed run exits nonzero. Admission errors reject before initialization; they do
not produce a run artifact. New versioned artifacts support [verification replay](timeline-replay.md)
within the declared matching environment and artifact size bounds. Full artifact
directories and a cross-environment qualification matrix remain future work.

## What is supported

The production parser validates configuration first. The Java profile then requires:

- Empty memory storage, unprotected access, one source, one view and one field.
- Untracked source progress, envelope entity mapping, partial publication, arrival
  reconciliation with one input, accepted late input, no conflict/fact/property policy.
- Receipt-age freshness with a threshold no greater than one hour.
- At most 20 streams, retained identities and history entries; delivery queues up to
  128 messages and 1 MiB. Both disconnect-on-overflow and coalescing are exercised.

All admitted action kinds execute: connection lifecycle, retained publication send
and identical retry, subscription/unsubscription, writer stall and release (including
failed release). Logical actor names do not determine runtime roles. Reconnects use
fresh internal identities; observations remain cumulative for the logical actor.

Links are explicit and bidirectional, with [fixed one-way virtual latency](timeline-links.md). Optional [receipt-loss rules](timeline-faults.md)
use the seed for reproducible integer decisions. Selected loss closes the source
connection in the next causal round, invalidating both directions; later sends
require explicit disconnect/reconnect actions and a fresh generation.
Arbitrary delays, other probabilistic faults, restart,
SQLite, protected access, multiple fields/sources and other reconciliation strategies
are outside this qualification. Unsupported configurations fail rather than falling
back to the fixed fixture or a projection implemented in Workbench.

Document execution bounds are stricter than syntax admission: ten actors and ten
connect actions in total, 4 KiB per canonical retained publication and 64 KiB of
configuration text. Limits allow up to 2,000 turns, 100 causal rounds, 1,000 queued
events, 1,000 pending messages and 16 MiB of trace (minimum 1 KiB). Turn accounting
bounds bridge commands, delivery callbacks and assertions as well as agenda dispatch.

## Ordering, evidence and failures

All actions enter the agenda before execution. Ordering is virtual time, causal
round, phase and declaration order. Real expiry tasks run before same-time source
inputs. Writer work follows input bursts; there is no hidden drain after each
publication. Assertions run after all work at their timestamp settles and compare
complete cumulative receipt/frame arrays using exact JSON numbers. Expectations
are supplied by the scenario, never generated from runtime output.

The trace distinguishes commands, scheduled/dispatched/cancelled tasks, state,
receipts, handoffs, completed frames, delivered/dropped messages and assertions.
Parent IDs retain the executing cause; additional `causes` retain earlier scheduling
or handoff ownership. Connection generations prevent stale callbacks from reaching
replacement connections. No snapshot reads repair missing scheduled effects.

[Managed retry actors](timeline-retries.md) add explicit bounded virtual deadlines
and fresh-generation retries. Their pending timers are included in end counts,
and every managed actor must acknowledge before success.

End conditions are checked before teardown. A passing result's counts describe that
boundary, even if shutdown then cancels permitted future tasks. Assertion/limit
failures retain a completed failure prefix; failure counts are the last observed
runtime counts, which can include due tasks when execution stops mid-turn. An
infrastructure failure retains an incomplete trace prefix and cannot be certified
as a complete run. Trace wrappers count toward the 64-level JSON depth bound;
a structurally oversized runtime effect stops execution and retains the preceding
incomplete prefix. Failed runs force-close the JVM; only successful runs record
normal shutdown. Host watchdog time is never simulation time.

The warehouse example asserts literal initial/fresh/stale frames and applied/
duplicate receipts across a reconnect. Focused tests also cover exact integers above
JavaScript's safe range, both delivery policies, failed release, reconnect cleanup,
end policies and budgets. Fresh JVM runs with bridge delays, pacing and host pauses
longer than the freshness threshold produce identical semantic traces. These checks
qualify this bounded profile, not every configuration accepted by ZooGlass.
