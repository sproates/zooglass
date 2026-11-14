# Detecting a real-clock freshness leak

The clock-leak control checks that host pauses can expose a runtime defect, beyond
the campaign checker's negative controls. It deliberately mutates a **separate copy**
of Java sources. The ordinary runtime and prepared JAR remain unchanged.

Prepare explicitly, then test the two prepared artifacts from `workbench/`:

```sh
python3 scripts/prepare-clock-leak.py ../../artifacts/clock-leak-build
npm run timeline:clock-leak -- ../zooglass/simulation-host/target/zooglass-simulation.jar ../../artifacts/clock-leak-build/zooglass/simulation-host/target/zooglass-simulation.jar ../../artifacts/clock-leak-evidence
```

Both destination directories must be new. Preparation builds Java; the check never
builds. The copy retains a mutation description and before/after source hashes.
The mutant is admitted using its own JAR hash: rejection at handshake or replay
identity checks cannot count as a successful negative control.

## Defect and independent expectation

The mutant anchors `System.nanoTime()` when receipt deadlines are installed.
At expiry reconciliation it wrongly uses the greater of virtual time and receipt
virtual time plus host elapsed time. Scheduling and receipt timestamps still use
the injected clock. This deliberately introduces host-time leakage on the real
freshness path; it neither consults pause settings nor alters assertions.

The published warehouse scenario independently requires freshness through virtual
time 59 for a receipt at time 10 with a 50 ms threshold. The next same-publication
retry is at time 20. With a host pause after receipt installation, the mutant
expires at that retry, 40 virtual milliseconds early, and fails `fresh`.

The check repeats six cases three times, each with a fresh JVM:

| Artifact | No pauses | JVM pauses, 90 ms         | Node command pauses, 70 ms |
| -------- | --------- | ------------------------- | -------------------------- |
| Normal   | Pass      | Pass, same complete trace | Pass, same complete trace  |
| Mutant   | Pass      | `assertion-failed: fresh` | `assertion-failed: fresh`  |

The normal results are checked by the document campaign validator. Mutated
results must be rejected by that validator for the named assertion, contain a
stale state at time 20, and retain their own valid artifact identity. Infrastructure
failures, missing observations or a failed unpaused baseline fail qualification.
An overloaded host can therefore make this control inconclusive; the tool retains
that failure rather than retrying until it passes.

Node pauses happen before framed runtime commands, including successive commands
at virtual time 10. They are within processing of a virtual timestamp, **not inside
an active Java turn**. JVM pauses cover the latter. Node diagnostics record each
command's virtual time, requested pause and measured elapsed duration outside the
semantic trace; qualification requires observed durations beyond 50 ms. Focused
tests also exercise the automatic-retry and delayed-link documents with 70–90 ms
Node pauses. Host pauses are bounded to 250 ms.

## Evidence and limits

The output retains all completed run JSON files, embedded inputs/configuration,
execution/environment identities, trace and pause observations, plus a summary
with file hashes and outcomes. A failure leaves available evidence and marks the
summary unqualified. Keep the build's mutation description alongside it.

This proves detection of this specific real-clock leak under the observed
environment. It is not proof that every possible clock leak or persistence defect
will be detected. It does not add SQLite, restart or cross-platform qualification.

## Recorded result, 13 November 2026

All 18 runs met the table above: nine normal passes, three unpaused mutant passes
and six paused mutant failures at `fresh`, with stale state observed at virtual
time 20. The campaign validator rejected each mutant failure for that assertion.
All completed runs and their inputs, diagnostics and identities are retained locally
in `clock-leak-check-final-20261113` and are now retained in the
[macOS evidence archive](../evidence/README.md).

- Summary SHA-256: `5eb1508b20269ed44d61a5ed9f6068cb17ee5538b7650346538b2aafb723d93d`.
- Normal JAR: `a2d365e9777cff6a9ccd4cbedf4bf2e31e772e6ac649922ce34f310262ebd63f`.
- Mutant JAR: `8de49ae57911e122b4f4733863e55ce91b12b5d0527ea51782fa64f6603ff1e6`.
- Workbench modules: `8d9cf83458501d4969d0629a249ab4a1a79c1a1041ab22f60ad8563c17b3dfc3`.

Environment: macOS arm64, Node 26.0.0, Homebrew Java 25.0.5.0.2,
Europe/Gibraltar. Normal and mutant were executed under matching environments.
The normal JAR is unchanged from the earlier 900-run campaign.
