# Verify a saved document run

Verification replay starts a fresh ZooGlass JVM with the saved inputs, then compares
newly emitted semantic records with the saved trace. It never supplies saved receipts,
frames or state as runtime outputs. Inspection alone does not execute anything.

From `workbench/`, using an already prepared current POC JAR:

```sh
npm run timeline:execute -- scenarios/simulation/warehouse-retry.json /tmp/warehouse-run.json
npm run timeline:replay -- /tmp/warehouse-run.json /tmp/warehouse-replay.json
```

Both commands accept a prepared JAR as their final optional argument; neither builds
Java. Prepare explicitly with `npm run prepare:timeline` when Java changes. Replay
uses the embedded canonical scenario and exact configuration text: original input
files need not exist, and the saved configuration path is never opened.

## Matching boundary

V1 execution outputs have `format: timeline-run/v1`. Lifecycle, Fleet, Order and
Sports profiles use `timeline-run/v2` and matching scenario/trace/bundle versions.
Replay requires a complete
canonical trace ending in `passed`, `assertion-failed` or `limit-exceeded`. It checks
the scenario hash, exact configuration hash, header/result consistency, prepared
JAR hash and actual Workbench module hash. It also requires the recorded dependency
lock hash, Node/V8 versions, platform, architecture, locale/timezone and actual JVM
runtime/vendor/OS/architecture/locale/timezone to match, plus SQLite version for
SQLite runs. The fixed executor revision identifies each profile's scheduling,
encoding and protocol behaviour. Runs begin with empty memory or a new SQLite
database as declared by the scenario. SQLite restart profiles retain that run's
store between generations; replay never imports an earlier run's database.

These are conservative identity checks for the bounded
[supported profiles](timeline-guide.md), not a cross-platform qualification matrix
or a signature proving who created a run.
Changing the scenario/seed/configuration consistently creates a different run; hashes
cannot establish historical authenticity. Changing runtime or Workbench artifacts
is a differential experiment, not exact replay, and is rejected here.

Single-file replay input must be a regular UTF-8 file no larger than
16 MiB, including JSON escaping and embedded inputs. A run's trace budget alone
does not guarantee its enclosing artifact fits this limit. Oversized files reject
explicitly. Bundles retain the same per-file bound, including their run envelope.
Old unversioned outputs,
incomplete/infrastructure-failed runs and unknown formats are rejected. Capture a
new run with the current executor instead of relabelling an old artifact.

## Reading the report

- `status: verified` means every emitted record, including the final result,
  matched. `recordedOutcome` remains the scenario result: reproducing an assertion
  or budget failure verifies that failure, not successful scenario behaviour.
- `status: diverged` includes the zero-based first differing `record` (header is
  zero), full canonical `expected` and `actual` records, and `matchedRecords`.
  A missing side is `null`. Records retain agenda keys, event IDs and causal parents.
  The `actual` run contains fresh evidence through the mismatch. Execution stops
  before processing further effects or sending further commands; a Java turn may
  already have computed its batch of effects before the mismatch is observed.
- `status: infrastructure-failed` means execution could not produce a complete
  comparison, and includes the available fresh prefix. It is never verified.
- Invalid evidence or identity/environment mismatch rejects admission with a reason;
  no replay report is written. JVM environment matching requires a handshake but
  happens before runtime initialization.

Replay is strict by default: exit 0 means verified and passed; exit 2 means a
verified assertion or budget failure. Exit 1 means divergence, infrastructure
failure or invalid/rejected evidence. Use `--verification-only` to return zero
for reproduced scenario failures; reports still retain their failed outcome.
`--require-passed` remains a redundant alias for the default. Flags cannot be
combined or repeated. Reports must be new files; exclusive creation refuses
existing files, including symlink and hardlink aliases of saved evidence.

Focused evidence includes fresh delayed/paused JVM execution after original files
are removed, exact large payload numbers, reproduced assertion/budget failures,
changed-effect first divergence, corrupt/incomplete evidence and identity/environment
rejection. This original replay evidence covers the memory document profile;
later lifecycle, Fleet, Order and Sports qualification is linked from the
[capability guide](timeline-guide.md). None establishes cross-environment equality.

[Run bundles](timeline-artifacts.md) add a complete file inventory and manifest
check before this same re-executing replay path.

See the [CLI and capability guide](timeline-guide.md) for comparison, setup,
profile/environment limits and the complete exit-status table.
