# SQLite persistence profiling diagnostic

This command prepares one unprofiled/profiled pair to investigate time spent in
SQLite row writes and commits while a workload accumulates pending publications.
It is a diagnostic, not a capacity qualification or the frozen performance campaign.
It preserves WAL/FULL durability and the driver's existing accounting and bounds.

## Prepare and run

Use Node 26, Python 3 and a Java 25 JDK with `jdk.MethodTiming` support. Set
`JAVA_HOME` to that JDK. The command uses an already prepared service JAR; it never
builds Java. The full diagnostic requires the retained measured JAR, SHA-256
`ff35ccd771993ea537b9d5887415fb5358acbf6a35061830bd6176c5cebaab90`.
A smoke run permits another prepared JAR and records its identity, but cannot be
used to extend the published performance result.

From `workbench/`:

```sh
npm run benchmark:sqlite-profile -- /absolute/path/new-output \
  --conditions "host, volume, competing load and power conditions"
```

Use `--smoke` after the conditions for a short tooling check. The output directory
must not exist. There is no resume or automatic retry. POSIX locking prevents
another runner from reusing the directory while the worker or service owns it.
SIGINT/SIGTERM requests cancellation and retains available evidence.

The fixed full pair runs unprofiled first and profiled second. Each uses a fresh
JVM and SQLite store, the baseline workload (100 resident entities, 16 changing
entities, one source, view and viewer, 256-byte payload), fixed 512 MiB heap and
worker-based resource sampling. After 60 seconds of settling before launch,
it seeds the store, warms for 30 seconds, measures for 60 seconds at 300/s and
allows up to 10 seconds to drain. The runner cancels active work after five minutes per
attempt or twelve minutes for the pair. It then closes the owned processes and
retains available raw driver evidence. The order is fixed, so one pair cannot separate order
effects or quantify profiler overhead precisely. Retain both arms and failures.

## Evidence and interpretation

The output retains identity/conditions, actual JVM options, driver reports, raw
observations, metrics, resources and stopped SQLite databases. The profiled arm
also retains the exact settings, bounded JFR recording, exported method events
and derived timing. Inventories pin result bytes and summaries pin input hashes.
`completion.json` distinguishes a completed pair from an interrupted or invalid
recording. On interruption it includes the reason, the current arm, the arms
started and the number with finished summaries. Completion is not a passing capacity result.

JDK 25 `jdk.MethodTiming` measures approximate elapsed time, including waits.
The four filters cover ingress handling, state installation, changed-row writes
and JDBC commit. The analysis takes differences of cumulative invocation counts
and `count × average elapsed time` between common snapshots within measurement
seconds 20–50. It reports the actual selected timestamps and interval, not a
fictional exact 30-second sample. Parent and child method times overlap: compare
write and commit as sibling operations, and never add them to their parent totals.
The counters cannot provide per-call percentiles or isolate physical fsync latency.

`comparison.json` applies the actual JFR endpoints to both arms at the same
offsets from each measurement start. It counts submissions, receipts and updates
in that interval, including callbacks for earlier work, and gives receipt and
fan-out backlog at both endpoints. The interval includes its starting instant
and excludes its end. Compare these counts with completed method calls, allowing
for clock uncertainty and callbacks crossing snapshot boundaries. Review the
retained driver windows for early stops before interpreting partial intervals.

Clock anchors bracket wall-clock reads with monotonic timestamps. The analysis
rejects wide anchors or detected clock shifts, incomplete methods, counter resets
and insufficient snapshot coverage. Checks do not establish that an undetected
clock excursion or host disturbance was impossible. Full recordings and raw
observations remain available for independent inspection.

Before attributing time, check whether backlog recurred, whether both arms offered
comparable load and whether profiling materially changed observed behaviour.
Timing misses remain visible and disqualify capacity claims. A failed drain at
this load is retained as a driver failure, not hidden by calling the pair complete.
Correctness faults, cleanup failures, cancellation or invalid profiling evidence
stop the pair. If observations do not support a comparison, the finding is
inconclusive. No automatic optimisation or durability change follows.

The [published 100/s result](performance-baseline-20261125.md) remains unchanged.
If commit time dominates, a separately scoped storage-call timing probe may be
useful. If changed-row writes dominate, inspect encoding and SQL execution.
Either decision needs the actual evidence; this tooling alone identifies no bottleneck.
