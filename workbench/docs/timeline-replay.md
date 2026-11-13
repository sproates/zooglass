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

New execution outputs have `format: timeline-run/v1`. Replay requires a complete
canonical trace ending in `passed`, `assertion-failed` or `limit-exceeded`. It checks
the scenario hash, exact configuration hash, header/result consistency, prepared
JAR hash and actual Workbench module hash. It also requires the recorded dependency
lock hash, Node/V8 versions, platform, architecture, locale/timezone and actual JVM
runtime/vendor/OS/architecture/locale/timezone to match. The fixed executor revision
identifies this profile's scheduling/encoding/protocol behaviour; all runs start
from empty memory state as declared by the scenario.

These are conservative identity checks for the bounded `memory-arrival-v1` profile,
not a cross-platform qualification matrix or a signature proving who created a run.
Changing the scenario/seed/configuration consistently creates a different run; hashes
cannot establish historical authenticity. Changing runtime or Workbench artifacts
is a differential experiment, not exact replay, and is rejected here.

This initial single-file replay input must be a regular UTF-8 file no larger than
16 MiB, including JSON escaping and embedded inputs. A run's trace budget alone
does not guarantee its enclosing artifact fits this limit. Oversized files reject
explicitly; larger artifact directories remain future work. Old unversioned outputs,
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

By default, replay exits zero for `verified`, including a faithfully reproduced
scenario failure. Add `--require-passed` when using replay as a behavioural gate:

```sh
npm run timeline:replay -- /tmp/warehouse-run.json /tmp/warehouse-replay.json --require-passed
```

With that flag, exit 0 means verified and scenario passed; exit 2 means verified but
the scenario failed an assertion or exhausted a budget. Exit 1 means divergence,
infrastructure failure or rejected/invalid evidence. The report always preserves
`status` and `recordedOutcome`; verification never relabels scenario failure as pass. The output includes the fresh run;
diagnostic error wording is not part of semantic equality. The report path must be a new file: exclusive creation refuses existing files,
including symlink or hardlink aliases of the saved evidence.

Focused evidence includes fresh delayed/paused JVM execution after original files
are removed, exact large payload numbers, reproduced assertion/budget failures,
changed-effect first divergence, corrupt/incomplete evidence and identity/environment
rejection. General faults, SQLite/restart, artifact migration and cross-environment
qualification are outside this slice.

[Run bundles](timeline-artifacts.md) add a complete file inventory and manifest
check before this same re-executing replay path.
