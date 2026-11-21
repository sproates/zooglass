# Static recovery qualification

Status: tools under review; retained qualification results are not yet published.
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
