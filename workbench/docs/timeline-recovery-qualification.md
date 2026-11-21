# Static recovery qualification

Status: qualification passed on 21 November 2026 at source
`8a77d52ea409cf02c2d17b05b8bf36bd36cf6eb3`; delivery awaits this PR's merge.
[Retained evidence](../evidence/README.md) includes exact inputs, raw runs and
replays, service observations, mutation provenance and the offline audit.
The [accepted design](../../docs/design/timeline-static-recovery.md) fixes the
scope at 28 executions on the recorded macOS arm64 environment.

## Evidence set

- Six reviewed fixtures each run normally and with long measured Node/JVM pauses;
  strict replay of both recordings makes 24 executions. Canonical semantic traces
  must match exactly between normal and paused runs.
- Normal and deliberately broken SQLite recovery run S1: two executions. The
  mutant must restart successfully and fail `restored-a` with empty state.
- M1 and S1 run against the ordinary service: two executions. Explicit barriers
  compare authored receipts, public state and new-connection snapshots. Strict
  orderly shutdown must succeed before restarting; forced cleanup fails the check.

The corpus is [static recovery](../scenarios/timeline-static-recovery/README.md).
Generation clocks and exercised pause sites are frozen in
`recovery-campaign-checks.ts`. Duplicate/rejection-only generations require no
state-effect pause. Tests and runners never build Java.

## Reproduce

Run these commands from `workbench/`. First explicitly prepare isolated normal and
mutant artifacts; this builds copied committed Java sources in a separate Maven
repository and retains the exact mutation recipe and artifact inventories:

```sh
python3 scripts/prepare-static-recovery-mutation.py /tmp/new-recovery-preparation
```

After committing the reviewed qualification tools and inputs, create an empty
parent evidence directory and run each bounded component once:

```sh
mkdir /tmp/new-recovery-evidence
npx tsx scripts/recovery-campaign.ts /tmp/new-recovery-evidence/campaign /tmp/new-recovery-preparation/normal.jar
npx tsx scripts/recovery-control.ts /tmp/new-recovery-preparation /tmp/new-recovery-evidence/control
npx tsx scripts/recovery-service-parity.ts m1 /tmp/new-recovery-evidence/service-m1 /tmp/new-recovery-preparation/service qualification
npx tsx scripts/recovery-service-parity.ts s1 /tmp/new-recovery-evidence/service-s1 /tmp/new-recovery-preparation/service qualification
npx tsx scripts/recovery-audit.ts /tmp/new-recovery-evidence /tmp/new-recovery-audit.json
```

The auditor rechecks raw observations, pause evidence, literal expectations,
record/replay consistency, mutation scope and source/artifact identities. Success
flags and recomputed summary hashes alone cannot make inconsistent evidence pass.
The service and simulation hosts must use the identical production runtime JAR.

Raw evidence belongs in a release asset; the repository retains its source commit,
SHA-256, environment and download link. Archive verification and a second audit of
the downloaded evidence precede publication of a qualification claim. Hashes prove
consistency, not authenticity against an attacker able to replace all evidence.

## Results and limits

The final set completed all 28 executions. Twelve campaign recordings contain
252 authored assertion observations and 2,200 trace records; all twelve strict
replays verify. Measured perturbations include 417 Node pauses and 22 JVM pauses.
Each normal/paused pair has exactly the same semantic trace.

The normal recovery control passes; the mutant reaches generation 2 and fails
`restored-a` at virtual time 60 with empty version-0 state instead of restored
version 4. Each ordinary-service case checks six full receipts, three full
subscription snapshots and two orderly shutdowns; M1 has ten HTTP checkpoints,
S1 twelve. Both use the same production runtime as the simulation host.

The offline audit passes, and nine tampering cases are rejected even when relevant
summary hashes are recomputed. The recorded environment is macOS arm64, Node
26.0.0, Homebrew Java runtime 25.0.5.0.2 and SQLite 3.53.2. Memory correctly omits
SQLite metadata; all SQLite runs agree on the native version. Other environment
fields and within-case replay identities remain exact.

One earlier nine-execution attempt is retained separately. Its scenario runs
passed, but the campaign checker wrongly required memory and SQLite metadata to
have identical fields. A fail-before/pass-after regression corrected that check.
Those nine executions are not counted as passed qualification.

This evidence covers the bounded static recovery family only. It does not qualify
arbitrary configurations, cross-platform equality, mid-commit crashes, nonzero
link latency, automatic retries, richer transport faults or performance. Service
comparisons establish observed orderly termination; they do not prove execution
of every shutdown hook. Prepared artifacts and failed-run diagnostic databases
are retained locally, outside the release archive.
