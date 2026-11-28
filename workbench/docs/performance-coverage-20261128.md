# What the first performance campaign established

The first frozen campaign finished its schedule on 24 November 2026. It ran
45 attempts and skipped 15 under its baseline-selection rule. Seven attempts
passed and 38 were harness-limited. Finishing the experiment did **not** qualify
all its workloads or establish maximum ZooGlass throughput.

A separate comparison with the corrected driver subsequently established a
[100 publications/s operating point](performance-baseline-20261125.md): three
passing memory runs and three passing SQLite WAL/FULL runs. That result remains
the useful current baseline for the stated workload and host.

## Coverage of the frozen schedule

The [accepted design](../../docs/design/single-instance-performance.md) specified
five baseline rates, both storage modes and three repeats, followed by five
single-factor contrasts at a rate selected from each store's passing baselines.
The original journal records schedule exhaustion, not exhaustion of the time
budget. No unsuccessful attempt has been replaced or reclassified here.

| Original campaign group                                  | Attempted | Passed | Harness-limited | Skipped |
| -------------------------------------------------------- | --------: | -----: | --------------: | ------: |
| Memory baselines, 10/30/100/300/1000 per second          |        15 |      1 |              14 |       0 |
| SQLite baselines, same rates                             |        15 |      5 |              10 |       0 |
| Memory: resident state, senders, views, payload, viewers |         0 |      0 |               0 |      15 |
| SQLite: resident state                                   |         3 |      1 |               2 |       0 |
| SQLite: senders, views, payload, viewers                 |        12 |      0 |              12 |       0 |
| **Total**                                                |    **45** |  **7** |          **38** |  **15** |

Only the original SQLite 10/s baseline passed all three repeats. Its comparisons
therefore used the design's lowest-passing-rate fallback, with no demonstrated
headroom. Memory had no all-three-passing baseline in that campaign, so the
selection rule skipped its comparisons. The lowest observed failing rates were
10/s for memory and 30/s for SQLite, both harness-limited; these are not service
capacity boundaries. No factor contrast qualified across all
three repeats. The later 100/s result cannot retrospectively supply a reference
for an earlier session with a different driver and uncontrolled physical placement.

Harness-limited does not mean the service failed to process every submitted item.
A missed sender slot, late send or failed client qualification can disqualify a
run even when submitted work completes. Warm-up qualification matters too; an
apparently complete measurement window cannot erase missed warm-up slots.
Conversely, SQLite's pending-work bound at 300/s and 1000/s exposed an accumulating
queue that must remain visible alongside generator limitations.

All three SQLite 1000/s attempts stopped during warm-up. Their measurement-phase
throughput is unavailable, not zero service capacity. Retain their planned
120,000 measurement slots as unoffered work rather than treating them as completed
or dropping the denominator. Latency percentiles in the original report describe
completed samples only.

## What remains unproved

- **Maximum rate:** neither the 100/s success nor a generator-limited higher-rate
  attempt establishes a universal throughput ceiling.
- **Scaling:** the five factor contrasts lack qualified repeated comparisons.
  This experiment does not establish how cost grows with entities, senders,
  views, payload size or viewers.
- **Other environments:** loopback results on one shared cloud setup do not
  measure application networks, clustered deployments or long-running operation.
- **Other persistence implementations:** memory results exclude durable-storage
  costs; SQLite results describe the current persistence path on its tested
  host and volume. They are not interchangeable performance promises.

## Disposition of the findings

Resource sampling and high-rate scheduling received bounded corrections. Their
paired diagnostics and original failures remain in the
[evidence collection](../evidence/performance-20261125.md). The corrected-driver
100/s result passed its own timing checks; 1000/s remains unqualified. Further
load-generator work is a separate decision, not a reason to hide earlier misses.

The SQLite backlog is retained as a limitation of the tested persistent
configuration. SQLite is the default durable backend; optimising it or adding
another backend is separate work. This baseline does not require weakening
commit durability, a storage-device investigation or a larger passing number.

The accepted completion rule permits failures and unmeasured cells when they are
reported with their evidence and next decisions. Coverage reconciliation is the
remaining publication step, not a request to rerun the matrix until it passes.
Any further measurement should answer a specific application or engineering
question, with its own bounded scope.

## Evidence

The [existing manifest](../evidence/performance-20261125.md) provides the producing
revisions, SHA-256 hashes and download links for the original campaign, paired
harness diagnostics and later six-run service comparison. Within the original
archive, `evidence/campaign/manifest.json` defines the 60 slots;
`journal.json` records all attempts, selections and the final session end;
`report.md` is the generated attempt report. Per-attempt inputs, observations,
metrics and resource samples preserve the distinctions above.

The original-campaign accounting audit independently replayed all 45 attempts:
2,322,994 observations, 210 inventoried files, all input/completion pairs and
5,400 one-second measurement buckets. Counts, timing, conditional percentiles,
backlog slopes, selection rules and outcome reasons matched. This checks the
retained accounting; it does not re-execute the service or independently replay
the application payload oracle. The six-run 100/s comparison has its own separate
audit. Neither audit turns the missing scaling comparisons into qualified results.

See the [original-campaign audit instructions](../evidence/performance-20261125.md#original-campaign-accounting-audit)
for the portable replay and its exact scope.
