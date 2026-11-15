# SQLite restart qualification

This campaign exercises three abrupt SQLite restart paths under the same recorded native
environment. It starts a new Node process for each run. Workbench opens an empty
SQLite store before the first runtime generation and reuses it across the stop
and restart within that run.

| Group               | What the checker verifies                                                                                                                                                                                                                          |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `durable-retry`     | The first commit at 10 ms loses its receipt. Attempt 2 at 20 ms is unavailable and arms no receipt timeout. Generation 2 starts at 50 ms with a stale version 2 snapshot, and attempt 3 gets the complete durable duplicate receipt for version 1. |
| `downtime-rollback` | Startup after a backward wall adjustment recovers unknown age. A duplicate preserves the recovered state and original receipt. New data restores freshness and expires at 80 ms.                                                                   |
| `masked-rollback`   | A new commit after a backward adjustment persists uncertainty for the old entity. At restart the wall clock has caught up, the old entity still has unknown age, and the new entity remains fresh until 71 ms.                                     |

The checker uses authored complete snapshot and receipt expectations, fixed
clock and alarm values, and independent receipt-loss draw vectors. It verifies
every trace before comparison and compares the complete semantic trace with the
unpaused run in the same group. Paused runs alternate 70 and 90 ms Node and JVM
delays, with observed delays after restart longer than the scenario's freshness
threshold. The durable retry case uses a client subscription to exercise a real
generation 2 writer handoff without changing the recovered view.

## Run it

From `workbench/`, use an explicitly prepared simulation host JAR. Tests and
campaigns use the supplied artifact directly. The watchdog uses POSIX process
groups so it can stop the host processes if a child times out.

```sh
npm run timeline:sqlite-repeat -- NEW_SMOKE_DIRECTORY ../zooglass/simulation-host/target/zooglass-simulation.jar 2
npm run timeline:sqlite-repeat -- NEW_QUALIFICATION_DIRECTORY ../zooglass/simulation-host/target/zooglass-simulation.jar 20
```

The smoke runs each group twice and checks that the campaign completes. A full
qualification uses a clean committed checkout and 20 runs per group, including
one baseline and 19 paused runs. The runner completes the baselines first and
uses up to three concurrent child processes for the remaining runs.

## Read the evidence

The output directory contains the exact inputs, the full output from each run,
and `summary.json`. The summary records the environment including native SQLite,
the source revision, tool and runtime hashes, expected results, exact commands,
trace hashes and any failure. Inspect the corresponding raw run for measured
pauses in each runtime generation. A semantic mismatch reports its first record.
Successful stores are closed and removed. Files retained after a failed run stay
under its private `stores/` directory for diagnosis.

This campaign qualifies the three cases in the recorded environment. It exercises
stops between acknowledged turns. Physical power loss and cross-platform trace
equality are outside this qualification.

## Recorded result, 14 November 2026

Tested commit `c5637500fb21f77eaf491067dd774bf295daf2d7` passed all 60 runs on
macOS arm64, Node 26.0.0, Homebrew Java 25.0.5.0.2 and SQLite 3.53.2. Each group
reproduced its baseline trace exactly across 20 fresh processes. All 240 literal
assertions passed. The 57 perturbed runs recorded 95 generation 2 JVM pauses
and 703 generation 2 Node command delays. The two modes requested Node/JVM
70/90 ms with pacing and 90/70 ms without pacing. Measured delays exceeded
the relevant freshness threshold; JVM pauses met their requested duration.

The [recovery-clock control](timeline-recovery-clock-control.md) passed with the
normal host and failed `unknown-after-recovery` with both mutant runs. The first
difference was the generation 2 initialization at record 13; the named failed
assertion was record 17 (zero-based). Both mutants reproduced the same wrong
trace: fresh version 1 and an alarm at 60 instead of unknown version 2 with no
alarm, while protocol clocks still reported the correct adjusted wall time.
The paused control observed a generation 1 JVM state pause and a generation 2
Node initialization delay; it fails before generation 2 JVM state work.

Actual JAR inventories confirmed only the receipt-clock class changed, with the
same embedded production runtime. The isolated hosts used Java source `898aa91`;
the campaign and checker used the clean tested commit above. A fresh strict
replay reproduced all 42 records of the downtime rollback and repair case.

The [evidence manifest](../evidence/README.md) retains the download link, hashes
and provenance for all raw runs, control inputs and audit. This closes the
bounded SQLite restart and adjusted-clock gate on the recorded environment.
Physical crash durability and cross-platform equivalence remain separate.
