# Timeline integration qualification

The bounded timeline is integrated alongside the existing Vehicle, Order and Sports
live demos, delivered to main through
[PR #172](https://github.com/sproates/zooglass/pull/172) on 15 November 2026.
The [integration plan](../../docs/design/timeline-integration.md) defines the scope
and rollback procedure; the [capability guide](timeline-guide.md) defines the
supported timeline boundary. Live demo commands retain ordinary process and network
timing. This integration adds no new deterministic profile.

## Candidate and reconciliation

Main base is `ad04db982cf32e4f26919a7ffbbb042e48212a78`; frozen POC is
`8e744b6a19753babe5e83b7539226c440eaee820`. Merge `370a8cf` retains both histories;
qualification candidate `baa892c8c4bb67ee41e34eeeb60b52a71198099f` has tree
`adac107a526e238ea0855df0b7c5551feeb05bc2`.

All 15 overlapping files were reviewed, including the five automatic merges.
The shared service session retains typed/generated configuration and exact-file
inputs, rejects conflicting forms before startup, preserves protected access, and
keeps database ownership explicit on close and startup failure. Package and CI
selection retain all three demos and the timeline tools. Current guides were
reconciled; historical evidence remains unchanged.

Java and timeline module sources, admitted profiles, parity oracles and dependency
lockfile match the frozen POC. All 204 production class bytes match its prepared
service artifact. Fresh service and host identities are recorded separately;
whole-JAR identity is measured, not inferred from matching class files.

## Fresh witnesses

Each case was recorded once and replayed once in strict mode. All 576 assertions passed
and all 6,158 emitted records matched. No seed multiplier or historical campaign
rerun was used.

| Case                           | Matched records |
| ------------------------------ | --------------: |
| Warehouse receipts/retries     |              84 |
| Memory restart                 |             107 |
| SQLite restart                 |              30 |
| Fleet                          |             432 |
| Order                          |           1,908 |
| Order recovery, after deadline |             865 |
| Order retention                |             416 |
| Sports                         |           1,973 |
| Sports retention               |             343 |

The isolated checkout installed dependencies and explicitly prepared artifacts.
Tests then consumed those JARs without building Java. Documented admission, bundle
record, strict replay and offline comparison passed. The initial inspection command
omitted its required mode and was rejected; the corrected documented admission
command passed without a source change.

## Regression validation

Focused session tests (14), protected Vehicle/Order and reset tests (13), and CI
selection tests (21) pass. Removing the new ambiguity guard makes its regression
fail for the expected reason. Startup-failure tests verify actual database creation,
caller-owned preservation and session-owned cleanup. Lint, formatting, type checks,
artifact packaging and changed-document links pass.

One existing ordinary-service qualification per demo passed from the clean
candidate. Fleet, Order and Sports retain their full raw observations, exact
configuration, inputs, identities and reports. These compare the production
service against independent expected checkpoints; they do not claim deterministic
wall-clock timing or cross-socket order.

[Full CI](https://github.com/sproates/zooglass/actions/runs/43655302691) passes all
11 jobs/gates across all eight selected groups: Java, static, core, demo, browser,
native, engines and reconnect. This includes Chromium/Firefox/WebKit rendering,
macOS/Windows lifecycle checks, and 103 browser-host tests. The independent review
found no outstanding issues in the reconciled source or fresh evidence.

## Retained evidence

The [integration archive](../evidence/README.md) retains 101 files (59,285,430 bytes):
all nine raw bundles/replays, the complete three parity directories, source and
artifact identities, local check logs, complete CI logs and the independent audit.
A downloaded copy passed the archive inventory and checksum verification.
Its SHA-256 is
`6b32669c96f5512c229c491d0ed6eb8cc4694e4f982560180b06043110488a89`.

The independent audit verifies bundle inventories, unchanged source boundaries,
production classes, strict replay equality and passing assertions. It compares all
36 Order and 66 Sports HTTP observations with retained expected states; a separate
Fleet audit checks 122 HTTP observations and matching client frames. These scripts
expect the recorded workspace layout, Git history and prepared local artifacts;
they are not standalone archive-only replay tools.

These witnesses are macOS arm64 checks, not a new cross-platform determinism
campaign. Historical campaigns retain their original source/environment limits.
The archive contains evidence rather than executable dependencies; replay still
requires matching artifact and environment identities. Website publication is
outside this integration.

## Promotion verification

Owner-authorised merge `a054bc8af090c682a8f4e6d5909f10859844aebe` preserves both
histories and exactly matches the reviewed `5160fe5` tree
`ccc8e63556652a0bf7f032e711a719c5a1405f97`.
[Final-head CI](https://github.com/sproates/zooglass/actions/runs/43656578789)
passes all eleven jobs/gates. Post-merge packaging checks and a strict 84-record
warehouse bundle replay pass using the prepared artifacts. No Java build or full
campaign rerun was needed for the identical tree. Evidence tags/assets remain
intact; merged integration, POC and plan branch names were removed after checking
that their histories remain reachable from main.
