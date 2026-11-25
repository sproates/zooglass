# Single-instance findings: 100 publications per second

On 25 November 2026, ZooGlass sustained **100 publications per second** in six
short baseline runs: three with memory storage and three with SQLite configured
for WAL/FULL durability. Every planned measurement publication was submitted on
time, acknowledged and delivered correctly. This establishes a measured operating
point for this workload, not maximum service capacity.

## Workload and host

Each run used 100 resident entities, 16 changing entities, one source socket, one
view, one viewer and a 256-byte payload. The driver and real ZooGlass service ran
on the same host over loopback. These are ordinary wall-clock service measurements,
not deterministic timeline timings.

The host was an AWS Stockholm m7i.xlarge: four logical CPUs, 16 GiB RAM, shared
host tenancy and an encrypted 50 GiB gp3 volume with ext4. The recorded CPU was an
Intel Xeon Platinum 8488C. Node was 26.13.1; Java was Temurin 25.0.5.1+2 with a
fixed 512 MiB initial and maximum heap. There was no other intentional user
workload. Physical placement, power management, thermal state and provider
background activity were not controlled.

Each attempt settled for 60 seconds before launching a fresh JVM with fresh
storage. After seeding, it had 30 seconds of warm-up, 120 seconds of measurement
and at most 10 seconds to drain. The order was
memory/SQLite, SQLite/memory, memory/SQLite. This targeted comparison used the
existing campaign execution and verification code, with 60 seconds of settling
rather than the full campaign's 30. SQLite retained the runtime's WAL/FULL settings;
the experiment did not query live pragmas or test crash durability.

Tested source: [`3df4c480e1081e513ab53812d582068e9da8d0eb`](https://github.com/sproates/zooglass/commit/3df4c480e1081e513ab53812d582068e9da8d0eb).
The prepared service JAR SHA-256 was
`ff35ccd771993ea537b9d5887415fb5358acbf6a35061830bd6176c5cebaab90`.
The retained manifest identifies the driver, scripts, dependencies and environment.

## Results

Latency is measured from the **planned send time**, so sender delay is included.
Each row gives the range of the three per-run p99s, not a pooled percentile.
Fan-out ends when all expected viewers have received the update; this workload
had one viewer.

| Storage         | Measurement publications | Receipt p99 (ms) | Fan-out p99 (ms) | Node CPU (% one vCPU) | JVM CPU (% one vCPU) |
| --------------- | -----------------------: | ---------------- | ---------------- | --------------------: | -------------------: |
| Memory          |          36,000 / 36,000 | 4.89–6.45        | 4.97–6.64        |                  23.8 |                  6.4 |
| SQLite WAL/FULL |          36,000 / 36,000 | 11.63–12.33      | 11.72–12.49      |                  24.6 |                 12.3 |

All six attempts passed the existing campaign criteria. Each submitted all 3,000
warm-up and 12,000 measurement slots with zero missed or late submissions.
Every measurement receipt arrived inside its measurement window. No receipts or
updates were missing, no oracle faults occurred and no work remained pending.
The final snapshots matched all 16 changing entities in every run. Offline checks
of the three stopped SQLite stores passed integrity checks and matched all 100
persisted entities against expected payloads and final observed versions.

Peak tracked in-flight work was two or three publications. The largest one-second
endpoint backlog was zero for memory and one for SQLite; all runs ended at zero.
The largest positive fitted backlog slope was below 0.00212 publications/s, below the
existing 1/s limit. There was no sustained backlog growth.

CPU figures use only measurement-window sample deltas, spanning about 357 seconds
per storage mode. Memory used 85 Node and 23 JVM CPU-seconds; SQLite used 88 and 44.
Counters have whole-second precision. Node includes the resource-sampling worker
but excludes external probe subprocesses. These are percentages of one logical
CPU, not of all four CPUs or a precise measurement of total host overhead.

## Why this is a scoped result

The first wider campaign produced seven passes and 38 harness-limited attempts.
Some SQLite runs at 300/s and 1000/s reached the driver's pending-work bound.
Those outcomes remain in the evidence; this report does not replace them with
passing runs or establish the cause of the SQLite backlog.

Paired client-only diagnostics identified resource-sampling interference, which
was reduced by moving sampling to a worker. A subsequent pacing change reduced
missed high-rate sends but used substantially more CPU. In the final paired
1000/s diagnostic, all six trials still failed timing qualification. Even this
100/s service session's short 1000/s diagnostic missed three of 1,000 slots.
The six actual 100/s service runs passed their own timing checks.

This evidence supports the stated 100/s baseline. It does not qualify 1000/s,
explain the earlier SQLite 300/s failure, establish maximum throughput, or cover
production network latency, long-running soak behaviour, larger configurations
or crash durability. Hardware identity changed between sessions and physical placement was unobserved,
so earlier results
are not controlled comparisons on the same physical machine. The wider frozen
workload/rate matrix and full performance publication milestone remain open.

## Evidence and verification

The [performance evidence manifest](../evidence/performance-20261125.md) pins the
raw comparison, earlier unsuccessful campaign and diagnostics, plus the portable
offline audit. Archives remain outside Git history. The audit recomputes counts,
latencies, submission timing and backlog from raw observations, derives
measurement CPU from resource samples, checks artifact hashes and verifies
stopped SQLite contents. It does not launch
Java, rerun the benchmark or use a cloud account.

The [campaign guide](performance-campaign.md) describes the general runner;
the retained comparison wrapper records the exact six-run experiment. Further
measurement should answer a bounded question, such as the SQLite 300/s backlog
or a separately designed higher-rate load generator. No capacity improvement is
claimed from merely improving the benchmark harness.
