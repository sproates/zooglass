# Portable timeline run bundles

Record a versioned document into a new evidence directory, using a prepared JAR:

```sh
npm run timeline:bundle -- record scenarios/simulation/warehouse-retry.json ../../artifacts/warehouse-run ../zooglass/simulation-host/target/zooglass-simulation.jar
npm run timeline:bundle -- replay ../../artifacts/warehouse-run ../../artifacts/warehouse-replay.json ../zooglass/simulation-host/target/zooglass-simulation.jar --require-passed
```

No command builds Java. The destination parent must exist, and recording refuses
any existing destination. Replay reports must be new files outside the evidence
directory. Existing single-file `timeline:execute` and `timeline:replay` remain
available.

V1 documents retain v1 bundle/run/trace formats. [Memory lifecycle](timeline-lifecycle.md)
documents use matching v2 formats and bridge protocol 2; mixed versions reject
before replay starts Java. Both profiles start with empty memory.

## Contents and completion

| File                 | Purpose                                                                                  |
| -------------------- | ---------------------------------------------------------------------------------------- |
| `scenario.json`      | Canonical expanded scenario, retaining exact numeric payloads                            |
| `configuration.json` | Exact admitted runtime configuration                                                     |
| `trace.jsonl`        | Semantic records appended as execution proceeds                                          |
| `run.json`           | Complete run envelope with inputs, trace, outcome and diagnostics                        |
| `manifest.json`      | Versioned inventory, byte lengths, hashes, execution/environment identity and provenance |

The manifest is written last. It identifies the scenario, trace, scheduler,
randomness and bridge protocol versions, the empty memory initial state, JAR and
Workbench module hashes, dependency lock and Node/JVM environment. Source revision
and tracked-change status are diagnostic provenance; they are null if Git metadata
is unavailable. Executable hashes, not a claim of a clean Git checkout, govern
replay. SQLite is not used or qualified by this profile.

Assertion and budget failures are completed semantic runs and can have a manifest.
They remain failures, even when replay verifies them. Infrastructure failures
retain available inputs, live trace and result, with `failure.json` where possible,
and no completeness manifest. Rejected inputs/startup failures retain their reason.
A killed process may leave only inputs and a trace prefix; replay rejects it.
This is process-interruption evidence retention, not a power-loss durability
guarantee or filesystem transaction.

Recording uses exclusive creation and never appends to an old bundle. Treat the
completed directory as immutable. Files are not signed or made tamper-proof:
hashes detect inconsistency, not a coordinated rewrite by someone able to edit
all evidence. An incomplete or malformed manifest never qualifies.

## Replay admission

Replay requires exactly the five documented regular files. Missing/extra members,
symlink members/directories, unsupported versions and size/hash mismatches reject
before starting Java. The loader also cross-checks the copied inputs and trace
against the run envelope, validates the complete trace and result, and checks
manifest execution/environment identity against that envelope. Recomputing one
file hash cannot hide disagreement with its retained counterpart.

The existing replay executor then checks the prepared JAR and Workbench hashes,
opens a fresh JVM, admits its environment, and re-executes retained inputs while
comparing newly emitted records. No saved output drives runtime behaviour.
Moving the directory or deleting the original scenario/configuration works:
recorded configuration paths are not reopened during replay. Each file has the
existing 16 MiB admission bound; oversized output remains incomplete.

Record exits 0 for a passing scenario, 1 otherwise. Replay exits 0 for verified
reproduction, including a reproduced failure by default. With `--require-passed`,
a verified scenario failure exits 2; invalid evidence, divergence and infrastructure
failure exit 1. The report preserves both verification status and scenario outcome.

## Scope

This packages admitted memory-runtime runs for copying or archiving and verifies
their completeness. It does not upload or back up files, bundle executables,
qualify Linux/cross-environment equality, or implement persistence/restart.
Keep the matching prepared JAR and Workbench revision available separately.
Earlier campaign evidence retains its original format, archived separately as
[GitHub Release assets](../evidence/README.md); it has not been converted to this
portable run-bundle format.
