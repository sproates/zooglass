# Memory lifecycle qualification

This bounded campaign checks `timeline-simulation/v2` memory restarts on one
recorded environment. It does not reuse the v1 900-run qualification, claim
cross-platform equivalence, or qualify SQLite recovery and wall adjustments.

With the host already prepared, run from `workbench/`:

```sh
npm run timeline:lifecycle-repeat -- ../../artifacts/memory-lifecycle ../zooglass/simulation-host/target/zooglass-simulation.jar 20
```

The output directory must not exist. Qualification requires a clean committed
checkout. A final argument `2` instead of `20` runs six smoke cases and cannot
qualify. Neither command builds Java. Three concurrent workers bound resource use;
each run launches a fresh Node process and fresh JVMs for runtime generations.

## Three distinct cases

- **Abrupt downtime:** publication at 10, lost receipt, stop at 11, unavailable
  attempt at 20, restart/retry at 50 and freshness expiry at 80. An extra downtime
  assertion at 25 must not start a runtime or move retries.
- **Orderly replacement:** stop/start at 15 invalidates a prepared source connection
  before its first send. The managed initial attempt reconnects to generation 2,
  sends once and becomes stale at 45.
- **Delayed receipt cancellation:** a publication sent at 10 arrives at 11; stop at
  12 cancels the returning receipt and old alarm. After start at 15 the external
  timeout survives, retry at 20 arrives at 21 and expires at 51.

Each group runs 20 times: one unperturbed baseline and 19 runs with long Node/JVM
pauses and pacing variations. Requested 70/90 ms pauses exceed each case's 30 ms freshness
threshold. Measured Node pauses must exceed 30 ms; JVM pauses must meet their
requested duration. Node timers can return slightly early because of granularity. The checker requires measured pauses during real generation-2 commands
and at the restarted JVM's state, writer and alarm sites, at their literal expected
virtual times. Metadata-only preflight does not count as a runtime pause.

Literal expected frames, receipts, attempt numbers, deadlines and loss draws decide
correctness. Exact within-group traces separately check repeatability. A repeatable
wrong result, missing pause evidence, mismatched inputs or environment, failed child
or incomplete matrix cannot qualify. Seeds only distinguish deliberately tested
loss behavior; the three groups are not multiplied into nominal seed combinations.

## Wrong-clock control

The separate [generation-clock control](timeline-generation-clock-control.md)
prepares a deliberately incorrect host in an isolated copy. It changes only the
runtime receipt wall clock after restart to `E + (T − S)`, while protocol metadata
continues to report `E + T`. The ordinary host must pass the same fixture; the
mutant must reach and fail the named `fresh-after-restart` assertion with the
precise wrong receipt timestamp. A perturbed mutant run must reproduce that wrong
semantic trace. An artifact mismatch or infrastructure failure is not detection.

Preparation is explicit and separate from checking:

```sh
npm run prepare:generation-clock-control -- ../../artifacts/generation-clock-prepared
npm run timeline:generation-clock-control -- ../../artifacts/generation-clock-prepared ../../artifacts/generation-clock-evidence
```

The negative control demonstrates that the oracle observes the clock used by real
runtime effects, rather than merely trusting echoed protocol clocks. It does not
prove detection of every possible clock bug. Existing direct generation tests
separately check monotonic reset and global alarm deadlines.

## Retained evidence

Keep copied inputs, every raw run, modes, measured pauses and the summary together.
Source, runner, runtime artifact, Workbench, dependency and environment identities
pin the tested combination. Trace mismatches identify the first differing record.
A completeness summary is not a substitute for checking raw files and their hashes.

Durable qualification evidence belongs in GitHub Release assets, with provenance,
SHA-256 and download links in the [evidence manifest](../evidence/README.md).
Archive verification checks bytes and inventory; replay additionally needs matching
executables and environment. These archives do not contain JARs or dependencies.
