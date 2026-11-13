# Document repeatability campaign

The qualification command runs three versioned document scenarios with three fixed
seeds, 100 times per combination, in fresh Node and JVM processes: 900 runs total.
It uses a prepared JAR and a clean committed checkout. It never builds Java.

```sh
npm run timeline:document-repeat -- ../../artifacts/document-campaign ../zooglass/simulation-host/target/zooglass-simulation.jar
```

The output directory must not exist. A final argument `2` runs an 18-run smoke check;
its summary explicitly says `qualified: false` even when all smoke runs pass.
Three workers bound concurrent runs. Each child has a host watchdog; failures retain
available artifacts and prevent complete/qualified status.

## What is checked

The scenarios are warehouse retry/expiry, automatic receipt-loss recovery, and fixed
link delays. Seeds are 64 repetitions of `0`, `1` or `2`. Every combination has its
own unperturbed baseline. Complete semantic traces, inputs, executable identities
and environments must match that baseline; traces are not compared across different
seeds. Baselines for all combinations also share runtime/module/environment identity.

Independent scenario assertions decide correctness before trace equality. For the
automatic retry scenario, seeds 0 and 1 acknowledge the initial applied publication;
seed 2 loses two receipts and acknowledges the third attempt's duplicate. Literal
SHA-256 vectors, independently calculated with Python's hashlib and length-prefixed
UTF-8 encoding, also check every draw and its expected loss sequence. No expected
observation is calculated from a baseline runtime result. All nine combinations
must pass their scenario assertions; reproducing a failed scenario does not qualify.

Each combination first runs with no host perturbation. Remaining repetitions vary
bridge delays (0–2 ms), pacing, Node-side idle pauses (0 or 70 ms), and JVM-side pauses
(70 or 90 ms). The scenarios use a 50 ms freshness threshold. JVM instrumentation
pauses exactly once at each of three sites while the original semantic thread owns
an active turn:

- Immediately before the first real state effect is retained.
- Immediately before the first real freshness alarm callback dispatches.
- At the first runtime writer handoff.

The instrumented JAR is identical for baseline and perturbed runs. The probe never
advances virtual clocks, emits semantic effects, reorders work or creates workers.
It records requested/observed host duration, site and virtual time in diagnostic
metadata only. Qualification requires all three sites to fire exactly once at their
independently expected virtual times, with observed pauses at least as long as
requested. Missing instrumentation fails the campaign. Ordinary runs leave pauses
disabled; the optional bridge probe setting is bounded to 0–250 ms. Interrupted
pauses or watchdog expiry are infrastructure failures, never simulated timeouts.

## Evidence and limits

The output retains copied scenario/configuration files, every complete run JSON,
and `summary.json`: source revision, campaign-code hash, matrix, expected outcomes/
draws, executable/environment identities, per-run host settings, trace/file hashes,
pause observations and completed/expected counts. A partial matrix cannot qualify.
Negative-control tests ensure changed traces and missing pause evidence are rejected.

This tests the admitted memory-runtime profile under a matching environment, using
fresh JVM instances. It is stronger empirical evidence, not a mathematical proof,
a cross-platform guarantee, or qualification of unimplemented configurations,
SQLite/restart or wall-clock rollback. The old two-fixture campaign remains separate;
its results must not be presented as document-executor campaign results.

The [recorded 900-run results](timeline-campaign-results.md) include the tested
revision, matrix, hashes, environment and limits.

The [real-clock leak control](timeline-clock-leak.md) separately demonstrates that
runtime host-time leakage can fail a behavioural assertion under these pauses.
The nine matrix cells above represent approximately four behavioural cases:
seeds do not affect warehouse retry or delayed links, which have no loss rules;
automatic retry has two selected loss patterns.

Raw evidence is retained in [versioned archives](../evidence/README.md).
[Linux qualification](timeline-linux.md) uses a separate environment and its own
baselines; it does not widen replay admission to mismatched environments.
