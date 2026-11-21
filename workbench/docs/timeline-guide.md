# Using the deterministic timeline

The timeline executes admitted scenarios through real ZooGlass strategies under
virtual time and ordered turns. Given the same scenario, configuration, seed,
artifacts and recorded environment, supported semantic results must repeat.
Replay executes again; comparison only examines saved evidence. Neither is a
promise about real socket timing, native thread races or arbitrary configurations.

## Prepare and run

Use a checkout containing the timeline commands, Node 26 and JDK 25. From `workbench/`:

```sh
npm ci
npm run prepare:timeline
node scripts/check-timeline-artifacts.js
run_dir="$(mktemp -d)"
npm run timeline:inspect -- admission scenarios/timeline-fleet/scenario.json ../zooglass/simulation-host/target/zooglass-simulation.jar
npm run timeline:bundle -- record scenarios/timeline-fleet/scenario.json "$run_dir/fleet"
npm run timeline:bundle -- replay "$run_dir/fleet" "$run_dir/replay.json"
npm run timeline:compare -- "$run_dir/fleet" "$run_dir/fleet/run.json" "$run_dir/comparison.json"
```

Preparation is explicit: it builds the ordinary service/runtime and separate host,
then checks the embedded runtime against the freshly prepared artifact. The Maven
wrapper resolves dependencies, so first preparation needs network access. Tests,
execution, replay and inspection never initiate builds. Reuse matching prepared
artifacts; rerun preparation after Java changes. An optional final JAR argument
selects another prepared host for execute, replay and bundle commands.

Use new output paths. A bundle retains complete inputs, run, trace and manifest.
It retains failure diagnostics when recording cannot complete; an incomplete
bundle cannot be replayed. Standalone execution uses
`timeline:execute SCENARIO NEW_RUN.json [JAR]`. Admission rejection produces an
error without a semantic run; a runtime failure remains distinct from a scenario
assertion or resource-limit failure. Reports do not overwrite evidence.

## Commands and exit statuses

| Command                                                                            | Purpose                                                                   | Exit status                                                                                           |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `timeline:execute SCENARIO RUN [JAR]`                                              | Execute a document                                                        | 0 passed; 1 failure or rejection                                                                      |
| `timeline:convert LEGACY DIRECTORY --runtime CONFIG --epoch-ms INTEGER --seed HEX` | Explicitly translate the static subset                                    | 0 converted, no scenario execution; 1 unsupported or invalid                                          |
| `timeline:inspect scenario FILE...`                                                | Validate document syntax                                                  | 0 valid; 1 invalid; execution not checked                                                             |
| `timeline:inspect admission SCENARIO JAR`                                          | Check configuration/artifact admission                                    | 0 assessment produced; read `execution: eligible/unsupported`; 1 invalid input or failed inspection   |
| `timeline:inspect static-configuration CONFIG JAR [REFERENCE]`                     | Check the broader static-memory family and optional normalized comparison | 0 assessment produced; read `requestedProfile`; 1 invalid input or failed inspection                  |
| `timeline:inspect trace FILE...`                                                   | Validate raw JSONL trace structure                                        | 0 valid; 1 invalid; no execution verification                                                         |
| `timeline:inspect legacy FILE...`                                                  | Assess ordinary scenario compatibility                                    | 0 assessment produced; read its limitations                                                           |
| `timeline:replay RUN REPORT [JAR]`                                                 | Re-execute saved run                                                      | 0 verified and passed; 2 verified scenario failure; 1 divergence, infrastructure failure or rejection |
| `timeline:bundle record SCENARIO DIRECTORY [JAR]`                                  | Execute and retain portable evidence                                      | 0 passed; 1 failure or rejection                                                                      |
| `timeline:bundle replay DIRECTORY REPORT [JAR]`                                    | Validate inventory and re-execute                                         | Same strict replay policy                                                                             |
| `timeline:compare LEFT RIGHT REPORT`                                               | Compare two saved runs or bundle directories                              | 0 equal; 2 different trace; 1 incompatible identities or invalid evidence                             |

Replay accepts `--verification-only` to exit 0 for a faithfully reproduced assertion
or limit failure. Reports still retain that failed outcome. `--require-passed`
remains a redundant compatibility alias for the default. Duplicate, conflicting
and unknown policy options are rejected.

Comparison requires identical recorded scenario, exact configuration, execution
identity and environment. Otherwise it reports `incompatible` with the differing
identity categories. Compatible runs report the first differing canonical record,
its zero-based index and both values; a missing side is null. Diagnostics and
message wording are excluded. Equality includes failed runs and is explicitly
labelled `executionVerified: false`: compare does not launch Java, check current
artifacts or establish that saved observations are true. Use replay for that.
Comparison and bundle replay reports must be new files outside input bundles.
Standalone replay requires a new report file; keep it outside any bundle directory.

## Supported capability matrix

These are bounded profiles, not automatic conversion of ordinary Workbench JSON.
Configuration admission is authoritative; follow each profile's linked limits.

| Profile                         | Storage and strategies                                                | Lifecycle and controls                                                                 | Evidence                                                                               |
| ------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `memory-arrival-v1` (v1)        | Memory, one latest-by-arrival field                                   | No restart; fixed links, receipt loss/retry, viewer control                            | [Document proof](timeline-execution.md)                                                |
| `receipt-age-restart-v1` (v2)   | Memory or SQLite, bounded latest-by-arrival                           | Stop/start between turns, receipt-age continuity; wall adjustments                     | [Memory](timeline-memory-qualification.md), [SQLite](timeline-sqlite-qualification.md) |
| `memory-sequence-fleet-v1` (v2) | Memory, bounded latest-by-sequence/history                            | Multi-source fleet; no restart                                                         | [Fleet](timeline-fleet-qualification.md)                                               |
| `sqlite-order-v1` (v2)          | SQLite, bounded mapping, priority and required contributions          | Progress/watermarks; no restart                                                        | [Order](timeline-order-qualification.md)                                               |
| `sqlite-order-restart-v1` (v2)  | Same Order configuration                                              | Explicit restart, retained identity/progress; no wall adjustment                       | [Order recovery](timeline-order-recovery.md)                                           |
| `sqlite-sports-v1` (v2)         | SQLite, bounded latest/first fact revision, count/sum                 | Progress and per-view atomic retirement; no restart                                    | [Sports](timeline-sports-qualification.md)                                             |
| `memory-static-views-v1` (v3)   | Memory, bounded arrival/latest/history mixtures and aliases           | Explicit conversion or authoring; zero-latency links, no retries/faults/restarts       | [Static configuration](timeline-static-qualification.md)                               |
| `static-views-restart-v1` (v4/v5)  | Memory or SQLite, bounded arrival/latest/history mixtures and aliases | Orderly/abrupt restart between turns; explicit reconnect and exact retry; zero latency | [Static recovery](timeline-recovery-qualification.md)                                  |

Unsupported fields, combinations and resource bounds reject admission. Declared
presend omission/order, fixed FIFO latency, lost source receipts and exact retries,
abortive close/reconnect and viewer writer faults retain their documented semantics.
Directional link stalls, interval fault selectors, variable latency, arbitrary
post-send frame loss and arbitrary mid-commit crashes remain deferred. TLS,
real browser/device behaviour and native concurrency need their separate tests.

## Environment and evidence

| Environment   | Retained qualification                                                                   | Limit                                                                                   |
| ------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| macOS arm64   | Document proof, lifecycle/SQLite, Fleet, Order, Sports and static configuration/recovery | Each archive pins its own Node, JVM, SQLite, locale, timezone and dependency identities |
| Linux arm64   | Original v1 document campaign                                                            | Does not qualify later profiles                                                         |
| Other systems | No retained qualification claim                                                          | Successful preparation alone is not qualification                                       |

Replay requires the recorded executor/modules, host JAR and environment identities.
Changing even CLI modules changes the current Workbench identity, so replay older
archives with their tested source checkout and matching artifacts. Offline compare
can inspect old runs without those installed artifacts. Hashes detect inconsistency;
they are not signatures. [Release manifests](../evidence/README.md) retain hashes
and download links; archived data excludes executable dependencies.

The [completion contract](timeline-completion.md) defines the bounded guarantee.
The [acceptance candidate](timeline-acceptance.md) records completed aggregate checks;
the [integration results](timeline-integration-results.md) record its delivery to main. Ordinary live
Workbench demos continue to serve their real-time purpose.

The [integration qualification](timeline-integration-results.md) checks the bounded
timeline alongside all three existing live demos, delivered in
[PR #172](https://github.com/sproates/zooglass/pull/172).

[Static configuration admission](timeline-static-admission.md) checks the broader family; [V3 conversion and execution](timeline-conversion.md) add projected assertions and retained conversion provenance.

## Static recovery

The [static recovery guide](timeline-static-recovery.md) describes the V4 family
combining reusable static configurations with memory/SQLite restart and explicit
retries. Its [fixed qualification](timeline-recovery-qualification.md) passes,
including pause-invariant traces, strict replay and ordinary-service comparisons.
The existing V3 converter and its evidence contract are unchanged.

### Explain recorded publication decisions

The optional [V5 recording and offline report](timeline-explanations.md) explains
production-owned static publication decisions without expanding the supported
simulation combinations. Older bundles remain readable as observed-outcome
summaries; they do not contain detailed strategy reasons.
