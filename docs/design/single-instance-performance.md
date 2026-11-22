# Single-instance performance baseline

Status: accepted in [PR #197](https://github.com/sproates/zooglass/pull/197).
This plan defines the first measurement campaign; no performance
results or capacity claims have been established by it.
The [campaign command](../../workbench/docs/performance-campaign.md) implements
checkpoint/resume and reporting on macOS and Linux local filesystems. The frozen
campaign and publication audit remain separate work.

ZooGlass has correctness evidence for reconciliation, durable recovery and client
delivery. We now need to measure the workload one instance can sustain and where
latency or resource use starts to rise. That gives users a useful baseline and
informs later clustering decisions. Availability remains a separate requirement.

This is a finite measurement exercise. It does not authorise an optimisation
programme or make a production service-level commitment.

## What we will measure

Run the ordinary prepared service JAR through its real WebSocket publication and
live-view interfaces, with terminal HTTP snapshot checks. Use one JVM and a separate
Node load process on the same otherwise idle host. All source and subscriber
callbacks use the load process's monotonic clock. Bind the service to loopback in
open-demo mode and use synthetic data. This measures local service/protocol costs;
it excludes TLS, application access policies, WAN effects and browser rendering.

Do not use virtual-time execution to measure wall-clock throughput. Reuse existing
Workbench artifact-only launch and cleanup where suitable, but keep the benchmark
out of the ordinary scenario scheduler and PR resource tests. Tests must never
invoke Maven. Building the service is an explicit preparation step before testing
or measurement. Offline explanation/bundle memory is outside this service baseline.

Measure memory and SQLite independently. Use production storage and delivery
settings, recording their effective values. Do not weaken SQLite durability,
disable checkpoints, or select an easier delivery policy to improve results.
Keep the same JAR, JVM heap settings, hardware and configuration capacities across
comparisons, apart from the stated workload contrast.

## Workload and fixed state

The baseline uses one declared source/epoch, one publication socket, 100 resident
entities and a fixed hot set of 16 entities visited round-robin. Each entity has its
own increasing publication sequence and exactly one ordered writer. One view has
one `latestBySequence` field. Every payload changes and includes an independently
generated marker and fixed padding. The encoded payload is 256 UTF-8 bytes; record
full envelope and delivered-frame sizes separately.

One viewer socket subscribes to all 16 hot entities before measurement. Use
`disconnectOnOverflow` with production default queue limits. Wait for subscription
acknowledgements and initial baselines before starting load. There are no retries,
progress controls, freshness timers, history fields, facts or runtime registration
in this campaign. These remain supported capabilities, but their costs are not
measured by this baseline.

Use `identityWindow: 64`, `maxStreams: 10000` and `maxHistoryEntries: 1000` in all
configurations. Preseed resident entities before warm-up; fill the retained
identity window for each hot stream. Measurement only replaces values and rotates
retained receipts within these fixed streams. No new entity or subscription is
introduced in the measured interval. Seed each cold entity once and each hot stream
through its 64 retained identities; verify all seeding receipts before subscribing.
Report preseed cost and state size separately. Warm-up continues the same stream
sequences. Keep warm-up obligations tracked across the measurement boundary and
report their late completions separately; they cannot satisfy measurement obligations.

Each execution starts a fresh JVM and a new store, then seeds and warms it.
SQLite uses a fresh local database per execution. Do not copy a live database or
reuse the previous execution's cache/state. Retain effective SQLite journal,
synchronous and checkpoint settings, storage device/filesystem, and database,
WAL and SHM sizes before and after measurement. Obtain effective database settings
from the prepared runtime configuration/code and stopped-store inspection as
appropriate; do not open a competing database owner or issue observation PRAGMAs
against the running service. Warm filesystem cache is part of
the stated environment; this is not a cold-disk benchmark.

## Finite campaign

Freeze the generated configurations, payloads, seeds and execution schedule before
measurement. Give each execution a stable ID and retain its inputs and hashes.

1. **Baseline:** 10, 30, 100, 300 and 1000 offered publications/second, both storage
   modes, three independent executions per rate: 30 executions.
2. **One-factor comparisons:** the following five variants, both storage modes,
   three independent executions each: at most 30 further executions.

| Variant | Change from the baseline | Question |
| --- | --- | --- |
| Resident state | 10000 resident entities, same 16 hot entities | Does cold retained state affect publication cost? |
| Concurrent senders | Eight source sockets, two disjoint hot entities per socket; same source identity and total offered rate | Does concurrent ingestion alter latency or throughput? |
| Views per publication | Four identical-policy views; subscribe to each hot entity in each view | What does additional projection and delivery cost? |
| Payload | 4096-byte encoded payload, same shape and changing marker | How does message size affect processing and delivery? |
| Viewer fan-out | Eight viewers, each subscribed to all hot entities | What is the cost of delivering each update to more clients? |

Choose each storage mode's comparison rate from its baseline results: the greatest
rate that passed all three executions and is at or below half its highest
all-three-passing rate. If no passing rate meets that headroom condition, use the
lowest all-three-passing rate and label the comparison as having no demonstrated
headroom. Always retain the baseline at the same rate; a failed or harness-limited
baseline cannot be a comparison reference. If no rate passes, do not run that storage mode's comparisons; publish
the observed failure and propose a separately reviewed investigation. A failing
comparison is useful evidence; do not lower its rate until it passes.

After seeding completes and all subscription baselines have arrived, each execution
has 30 seconds of warm-up at its selected measurement rate, immediately followed
by 120 seconds of measurement and at most
10 seconds of drain. Startup and preseed each have a five-minute deadline. These
are harness deadlines, not service guarantees. Use a fixed interleaved schedule
across storage modes and replicates so time-of-day and host drift are visible.
Allow a fixed 30-second idle interval between executions; record actual intervals.

The campaign has at most 60 scheduled run slots and six replacement attempts
shared between evidenced infrastructure failures and interrupted attempts. At most
66 attempts may start, including failed startup and partial measurements. Keep every
original attempt and its replacement relationship. Never replace a completed valid
slow or failing result. Stop after eight cumulative hours of active campaign time
or any safety limit; publish unfinished cells and
seek a bounded amendment rather than silently extending the campaign. Reaching
1000/s without a failure establishes only a lower bound under the measured budgets.
It does not establish maximum capacity.

## Pause, checkpoint and resume

Campaign execution must be scripted and resumable. One invocation can run the whole
campaign or stop after a requested number of completed attempts. An ordinary pause
request finishes the current attempt, saves its outcome and stops before starting
another. Resume is an explicit command against the existing campaign directory;
it does not require an agent to supervise individual runs or reconstruct progress.
This belongs to campaign implementation, not the initial diagnostic driver.

Before the first attempt, save an immutable manifest containing the campaign ID,
ordered run slots, workload templates, baseline-to-comparison selection rule,
limits, configuration/input hashes and execution identity. Record the JAR, driver
and dependency hashes, JVM options, Node/JVM versions, OS, architecture and host
hardware identity. Comparison rates are resolved only after baseline slots have validated results or
are explicitly terminal/incomplete because limits prevent replacement. Only three
validated passing replicates can qualify a rate; incomplete triples never supply
a comparison rate. Apply the frozen rule to qualifying triples, or skip that storage
mode's comparisons if none qualify. Save the resolution once, with baseline evidence
hashes and incomplete-slot reasons.
Resume preserves this order and resolution rather than selecting easier runs.

Every attempt has a unique directory and lifecycle record: planned, running,
completed, interrupted or infrastructure-failed. Save inputs before launch. Write
bounded observations and the result, close the owned service and output files,
then publish a completion record atomically with file hashes and outcome. A valid
completed failure is a completed attempt, not permission to retry. No completion
record may describe an unfinished write. This is restart consistency for the
runner, not a power-loss durability guarantee.

Resume validates the manifest, attempt records, file inventory/hashes, accounting
and execution identity before launching anything. It skips every validated
completed run, including slow or failed outcomes. If an attempt was marked running
when the runner stopped, preserve it as interrupted unless a valid completion
record already exists. Never join a partial interval to a later measurement.
A replacement starts with a new JVM, new store, preseed and warm-up, linked to the
original attempt, and consumes the shared six-attempt replacement allowance.
An exhausted allowance leaves that slot incomplete. A corrupted completed result
or mismatched identity stops resume; do not silently discard it or rerun it.
Changing code, configuration, dependencies or the recorded stable environment
requires a new campaign, not relabelling previous results as comparable.

Use exclusive campaign ownership so two commands cannot resume the same directory
concurrently. Recovery from an abandoned ownership record must establish that the
previous runner and its owned service are stopped before starting a replacement.
Do not kill an unrelated process or infer safe ownership from a reused PID alone.

Persist attempt counts and the remaining active-time budget across sessions.
Active time includes startup, seeding, warm-up, measurement, drain, cleanup, report
writing and mandatory inter-run waits. Intentional offline pauses do not consume
the eight-hour budget, but are recorded separately with UTC start/resume times.
Account active durations with a monotonic clock within each session; never compare
monotonic timestamps across processes. Persist the unique attempt ID, running state, attempt/replacement debit and active-time
reservation together as one recoverable launch decision before spawning. Freeze a
30-minute outer attempt deadline in the manifest, covering all phases, cleanup and
output writing; retain the shorter phase deadlines too. Do not launch without
sufficient reserved active budget. Reconcile the reservation with the completed
record exactly once. A crash after reservation consumes it even if launch cannot
be proved. Mandatory settling waits also reserve and reconcile active time; an
interrupted wait cannot disappear from budget accounting. After interruption, retain the
reservation for any duration that cannot be established rather than resetting or
increasing the remaining budget. Resume cannot reset deadlines or global limits.

Record session boundaries, pause reasons, actual gaps and host operating conditions
for each session. Retain the normal 30-second settling wait before the first resumed
attempt. Even with matching identities, sessions can differ in thermal state,
background load and filesystem cache; show those boundaries in the report instead
of implying one uninterrupted controlled run. No automatic retry of a valid slow
result is permitted because it occurred in a less favourable session.

Acceptance tests must interrupt the runner during setup, measurement, result writing
and between attempts, including a crash after reservation but before launch and
repeated resume; prove reservations are charged once, completed work is skipped and partial work is preserved
and restarted only within the replacement budget. Cover a completion record saved
before the campaign index update, corrupted evidence, changed identity, concurrent
resume, exhausted limits and a multi-session run whose report includes every original
attempt and pause. These are short fixture tests plus a small real-service resume
smoke, not repeated executions of the full campaign.

## Scheduling and latency

Use an open-loop schedule: planned sends depend on elapsed monotonic time, not on
receipt arrival. Use one global schedule with evenly spaced slots, assigning slots
round-robin to sockets so eight sockets do not emit simultaneous bursts. Record planned
send, actual WebSocket submission, receipt callback and each matching update
callback. Actual submission means the client called `send`, not proof that bytes
reached the server. Socket buffering and callback work are therefore included in
the observed boundary. Do not subtract estimated transport overhead.

Never burst to catch up with missed schedule slots. At each wake, at most the latest
elapsed global slot may be submitted; all earlier elapsed slots are recorded as
missed, even when they are less than 10 ms late. The latest slot is also missed if
more than 10 ms late. Qualify this rule with a sub-10-ms delay spanning several
scheduled slots, as well as a delay beyond 10 ms. Cap pending publications at 10000 and
total sender `bufferedAmount` at 16 MiB; hitting either records a harness-limited
execution and stops offering new work. Keep the intended schedule denominator,
including slots not submitted after an early stop. Cap raw accounting at two million observation entries and 512 MiB of encoded
measurement data per execution, whichever is reached first. Track actual retained
buffer sizes separately from encoded bytes. Stop explicitly on exhaustion instead
of silently discarding samples. Keep the raw data and driver limits in the manifest;
these are harness bounds, not a claimed process-RSS ceiling.

Report these values per execution and in one-second time buckets:

- Planned, submitted, successfully acknowledged, rejected, missing and mismatched publications;
  missed slots, queue/buffer high-water marks, disconnects and drain completions.
- Achieved successful publications/second: matching successful receipts for the
  measurement cohort received before the measurement window ends, divided by
  120 seconds. Memory success is `applied`/`memory`; SQLite success is
  `committed`/`sqlite`. Exclude warm-up receipts and report drain receipts separately.
  Also report completion of the cohort submitted during measurement, including
  its bounded drain.
- Scheduler delay, submission-to-receipt and planned-send-to-receipt latency.
- Submission-to-update and planned-send-to-update latency for every expected
  client/view/field delivery, plus time until the slowest required viewer receives
  each publication. Keep source acknowledgement and complete fan-out distinct.
- p50/p95/p99 and maximum, with sample counts, missing denominators and histogram
  range/precision. Mark sparse tails explicitly; do not assign latency zero to a
  missing observation or average percentile values across executions. Percentiles
  use completed samples only and must be labelled conditional on completion.

Match callbacks even when a view update arrives before its receipt. Use source ID,
epoch, source entity and publication sequence for receipts; use viewer, view,
canonical entity, field provenance and `publicationSequences` for updates.
A runtime version is not a publication sequence. Validate the receipt target and
changed fields for every expected view. Compare every expected live frame's full
payload, changing marker, provenance and publication sequence against independently
generated expectations, not just its correlation identity. Validate the expected
change result in the receipt too. Retain receipt and per-viewer delivery obligations
separately so a correct acknowledgement cannot conceal a wrong intermediate frame. In this constrained workload every new
publication changes its field, so every subscribed target must deliver it under
FIFO. Record unexpected extra frames and duplicates explicitly. Exclude initial
baselines and warm-up identities from measurement while retaining phase accounting.

After drain, read every hot entity in every view over HTTP and compare payload,
provenance and sequence with independent generated expectations. No expected value
may come from the receipt or snapshot being checked. Reconciliation, sequence or
payload mismatches are correctness failures regardless of speed.

## Passing, overloaded and inconclusive results

The initial reporting budgets are proposals for this experiment, not promises to
applications. A rate is sustained within these budgets only when all three
independent executions satisfy:

- No missed slots, harness limit, unexpected rejection, disconnect, duplicate,
  missing required receipt/update or incorrect terminal snapshot.
- Achieved in-window successful acknowledgements are at least 99% of offered rate; every submitted
  measurement publication and expected delivery completes within the bounded drain.
- p99 planned-send-to-receipt is at most 100 ms and p99 planned-send-to-complete-fan-out
  is at most 250 ms, with at least 1000 observations of each publication metric.
- Sample two measurement-cohort outstanding counts at each second boundary:
  submitted publications minus distinct valid receipts, and submitted publications
  minus publications with all valid expected viewer deliveries. For each count,
  fit an ordinary least-squares slope over the final 60 samples against elapsed
  seconds. Each slope in publications/second must be at most 0.01 times the offered
  publications/second. Report both series and slopes even when they drain;
  receipt completion must not conceal a growing viewer backlog.

Publish all measured values even when a budget fails. Distinguish an ordinary
service budget failure from a correctness failure, a load-process limitation and
an infrastructure failure. A missed-slot or sender-bound run cannot establish
service saturation. Report the highest passing tested rate and the lowest observed
failing rate, with failure category; do not interpolate an unmeasured maximum or
hide non-monotonic results. If no rate qualifies, that is a valid reported outcome.

Measure load-process CPU, RSS and event-loop delay alongside service PID CPU,
RSS, JVM heap and GC counts/time, and available process disk I/O. Record unavailable
metrics rather than inventing cross-platform equivalents. Sample at one-second
intervals outside callback hot paths; write accumulated results after measurement.
Record system memory pressure, competing processes, thermal/power settings and
sampling overhead. A shared-host result cannot separate all CPU/I/O contention
between client and service; state that limitation.

Before the campaign, qualify the scheduler/oracle with a controlled local protocol
fixture: delayed scheduling, missing/duplicate/wrong receipts, wrong payloads,
update-before-receipt and missing fan-out. Run a client-only diagnostic at 1000/s
with expected frame fan-out and sizes for the selected variants. Failure blocks
claims at that load, not publication of the lower-rate observations. This diagnostic
checks the harness and is not a ZooGlass performance result.

## Deliverables and implementation boundaries

Deliver through three implementation PRs after design acceptance:

1. **Driver and accounting:** a separate Workbench benchmark entry point, fixed
   workload generation, open-loop scheduler, bounded correlation and independent
   oracle. Unit/fixture checks prove missing work cannot disappear from results.
   Artifact-only service smoke covers one changing stream and terminal state.
2. **Campaign and reporting:** explicit configurations, deterministic campaign order,
   fresh-store lifecycle, checkpoint/resume and durable budget accounting,
   per-process sampling, classification, machine-readable
   results and a human-readable comparison. Fixture tests check percentile/slope
   calculations, phase boundaries, early-stop denominators and failure categories.
   Include low-rate real memory/SQLite smoke with multiple views and viewers.
3. **Published baseline:** run the frozen campaign, inspect anomalies, independently
   audit raw accounting and report workload-specific results and limitations.
   Keep raw data as Release assets with hashes and producing revisions committed
   beside a concise report. Verify downloaded evidence against its manifest.

The harness belongs under a cohesive `workbench/src/benchmark/` boundary; keep
source generation, execution, observation and reporting separate. Reuse transport
contracts without importing demo presentation or modifying production semantics.
Update source maps and command documentation with implementation. Normal CI runs
bounded correctness smoke tests, not the performance campaign or noisy rate gates.
The public README/website must not acquire performance claims before results exist;
any website update still requires its own preview and approval.

Completion means the bounded campaign and report are published with audit evidence,
including failures and unmeasured cells, and the next action for each material
anomaly is recorded. A discovered correctness defect blocks that configuration's
capacity claim and is fixed through the ordinary review process. A performance
bottleneck is recorded for a separately scoped optimisation decision. No mandatory
throughput improvement is part of this milestone. CPU/heap scaling, broader strategy
mixes, protected serving and multi-host tests remain explicit future measurements.

This baseline supports later [clustering and high availability](../../ROADMAP.md#further-direction)
planning. Operational logging remains the next agreed initiative; neither requires
an endless search for a larger benchmark number.
