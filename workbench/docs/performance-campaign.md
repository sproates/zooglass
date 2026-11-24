# Resumable performance campaign

The campaign runs the [accepted single-instance baseline](../../docs/design/single-instance-performance.md)
against a prepared ZooGlass service. It saves each attempt, checks saved evidence
before resume, and reports failures as well as passing results. The runner is
implemented; the frozen campaign and independent publication audit have not run.
No capacity claim follows from installing or testing this command.

## Prepare and run a piece

Use Node 26, Python 3 and a prepared Java 25 service on macOS or Linux, with a local
filesystem. Prepare Java explicitly before the campaign; neither the command nor
its tests build Java. Reserve an otherwise idle host and keep its power settings,
JAR, code, dependencies and JVM settings unchanged across sessions.

From `workbench/`:

```sh
npm run prepare:service
npm run benchmark:campaign -- create /absolute/path/new-campaign \
  --max-attempts 3 \
  --conditions "AC power, normal thermal state, other workloads stopped, local SSD"

npm run benchmark:campaign -- resume /absolute/path/new-campaign \
  --max-attempts 3 \
  --conditions "AC power, normal thermal state, other workloads stopped, local SSD"
```

Replace the conditions text with what you actually observed, including competing
load and storage details. The command records OS/architecture, CPU and memory
identity, versions and hashes separately. Host identity is hashed. Set `JAVA_HOME`
consistently if you use it. The campaign fixes the heap at 512 MiB minimum and
maximum. Environment flags that can silently change Java or Node execution are
rejected. Changing recorded inputs or execution identity requires a new campaign.

The create directory must not exist. Resume uses the same directory. The optional
attempt count limits this invocation, not the whole campaign. Without it, the
command continues within the campaign limits. Ctrl-C requests a pause after the
current attempt closes and saves; it does not splice partial measurement intervals.
A forced process termination preserves the incomplete attempt for recovery.

## What resume preserves

The schedule contains 30 baseline slots and at most 30 comparisons. Comparison
rates require all three baseline replicates to pass. Rates are selected once by
the frozen headroom rule; a failed comparison never triggers a lower offered rate.
Valid completed failures are skipped on resume, just like successful results.

All sessions share six replacement attempts and eight hours of active time.
Startup, seeding, measurement, shutdown, evidence checks, reporting and settling
waits consume this allowance. Intentional offline pauses do not. Interrupted work
retains its reserved time when its actual duration cannot be established. It is
charged once, even after repeated resumes. Each replacement starts a fresh service,
store, seed and warm-up. The 30-minute attempt reservation is a safety limit,
not the expected duration. Every attempt has a 30-second settling wait first.

An operating-system lock excludes concurrent runners and remains inherited by the
owned service. If the runner dies while its JVM survives, resume refuses ownership.
Do not remove or replace `.lock`. Establish that the owned service has stopped
before resuming; the runner never kills a process merely because its PID matches
an old record. Windows and network filesystems are outside campaign support.

## Read the result

- `manifest.json` freezes schedule, configurations, selection rules and identity.
- `journal.json` is the authoritative checkpoint for attempts, sessions, reservations
  and comparison-rate selection. Records contain consistency hashes, not signatures.
- `attempts/<id>/input.json` identifies the exact reserved work. A sealed
  `completed.json` inventories its closed files and hashes.
- `run.json` preserves configuration, planned and missing work, receipt/view
  accounting, actual wire-byte totals (including seeding and initial baselines), seeding times
  and terminal checks.
- `observations.jsonl` retains bounded raw timestamp and identity records.
  `metrics.json` derives completed-sample latency distributions, missing denominators,
  in-window throughput, drain receipts and separate receipt/fan-out backlog slopes.
- `resources.json` records the two processes, event-loop delay, JVM heap/GC, sampling
  overhead, store sizes and unavailable measurements. SQLite settings come from the
  prepared runtime; there is no competing live database connection.
- `report.md` compares individual attempts and tested baseline bounds, including
  unfinished slots. Session diagnostics test client-side parsing/accounting at
  1000/s for one second for each workload shape. A failed diagnostic prevents a
  passing 1000/s classification; lower-rate results retain their own evidence. They are not ZooGlass measurements.

The report is a derived snapshot written before the final session close. The journal
retains the final UTC close and charged duration. Resume verifies completed inventories
and recomputes accounting, metrics and classifications before starting more work.
A submission delayed beyond its eligible send slot stays in the evidence and
is a terminal harness-limited result, even if the host pause happened just before
the WebSocket send. It is never disguised as an interrupted attempt.
Corruption stops resume; it never silently replaces a completed result.

Results distinguish service-budget failures, observed correctness failures, harness
limits and evidenced infrastructure failures. Missing samples are never latency zero.
Percentiles use exact nearest ranks and remain conditional on completion; sparse tails
are marked. A successful command exit means the requested piece finished, not that
its attempts passed. Invalid evidence or an operational command failure exits non-zero.
The published baseline will need independent audit and downloadable, hash-checked
Release assets. That is a separate delivery step.

Resource probes run in a worker thread, with one non-overlapping sample per second
on a best-effort basis. Probe durations and start times use the sender's clock
origin. The sender's event-loop histogram is captured when a completed sample
arrives; it is not the worker's event-loop delay. CPU/RSS still describe whole
processes, so client CPU includes the worker but excludes its external probe
children. Sampling errors remain explicit unavailable fields; worker failure or
shutdown failure aborts evidence collection instead of silently claiming success.
Each external probe has a 1.5-second timeout with forced termination; normal
worker shutdown waits for in-flight probes to exit. Startup and shutdown have
five-second deadlines; at most 3,600 samples are kept
per sampler. The sampler is ready before seeding or timed diagnostic work begins.
Existing campaign evidence and acceptance criteria are unchanged. New executable
identity requires a new campaign, rather than resuming an older campaign with
a different sampler.

### Sender pacing

The service driver and client-only qualification use the same monotonic clock.
Long waits use a timer with a one-millisecond lead; with less than two milliseconds
remaining, the sender yields to the event loop and checks the deadline again.
This avoids sub-millisecond timer clamping without blocking socket callbacks.
It can consume substantial client CPU at high rates; report that cost alongside
punctuality. Host scheduling can still cause late or missed slots. The existing
slot policy, fixed windows and qualification thresholds remain unchanged: overdue
slots are skipped, never sent as a catch-up burst.
