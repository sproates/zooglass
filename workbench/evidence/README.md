# Retained timeline evidence

Raw qualification archives are downloadable GitHub Release assets. The original
v1 campaigns use [timeline-evidence-20261113](https://github.com/sproates/zooglass/releases/tag/timeline-evidence-20261113);
the v2 memory campaign uses [timeline-memory-evidence-20261114](https://github.com/sproates/zooglass/releases/tag/timeline-memory-evidence-20261114),
SQLite uses [timeline-sqlite-evidence-20261114](https://github.com/sproates/zooglass/releases/tag/timeline-sqlite-evidence-20261114),
fleet uses [timeline-fleet-evidence-20261114](https://github.com/sproates/zooglass/releases/tag/timeline-fleet-evidence-20261114),
Order uses [timeline-order-evidence-20261114](https://github.com/sproates/zooglass/releases/tag/timeline-order-evidence-20261114),
and Sports uses [timeline-sports-evidence-20261114](https://github.com/sproates/zooglass/releases/tag/timeline-sports-evidence-20261114).
Final acceptance uses [timeline-acceptance-evidence-20261114](https://github.com/sproates/zooglass/releases/tag/timeline-acceptance-evidence-20261114).
Git retains this manifest and [SHA256SUMS](SHA256SUMS). The archives contain no
executables or dependencies. Release assets remain available until explicitly
changed or deleted; their hashes below pin the exact published bytes.

| Archive                                                                                                                                                                                         | Files | Uncompressed bytes | SHA-256                                                            |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----: | -----------------: | ------------------------------------------------------------------ |
| [macos-timeline-20261113.tar.gz](https://github.com/sproates/zooglass/releases/download/timeline-evidence-20261113/macos-timeline-20261113.tar.gz)                                              |   937 |         49,428,333 | `39b7cdc54d190e65c54e8e6422663101c24b90533b38c05de6e792953008f558` |
| [linux-arm64-timeline-20261113.tar.gz](https://github.com/sproates/zooglass/releases/download/timeline-evidence-20261113/linux-arm64-timeline-20261113.tar.gz)                                  |   916 |         49,915,765 | `3440a2bda91cd51dd4a149db12e19516ec8c9cdb3926f51d6cd8e065d4baa4ff` |
| [macos-arm64-memory-lifecycle-20261114.tar.gz](https://github.com/sproates/zooglass/releases/download/timeline-memory-evidence-20261114/macos-arm64-memory-lifecycle-20261114.tar.gz)           |    83 |          4,533,024 | `9e78cc90cd607146cec7448c9980e930d83bd2f211d659f377eb67a5d3d29e5c` |
| [macos-arm64-sqlite-restart-20261114.tar.gz](https://github.com/sproates/zooglass/releases/download/timeline-sqlite-evidence-20261114/macos-arm64-sqlite-restart-20261114.tar.gz)               |    85 |          2,445,773 | `7462d391bc7fb4ccc89f11219e69cf12ffe9c7fb23dc8ac3de70ca7ca3b66cf2` |
| [macos-arm64-fleet-20261114.tar.gz](https://github.com/sproates/zooglass/releases/download/timeline-fleet-evidence-20261114/macos-arm64-fleet-20261114.tar.gz)                                  |    50 |         41,306,112 | `5ae53aa66c232c33c53ce409cf0cce5110fbc0ff9f40338d6a2a3111b87fba11` |
| [macos-arm64-order-20261114.tar.gz](https://github.com/sproates/zooglass/releases/download/timeline-order-evidence-20261114/macos-arm64-order-20261114.tar.gz)                                  |    78 |         79,200,269 | `833a0415701e098faebac4d2395eee6eeb1db77aa336580e05baa27af2a8372a` |
| [macos-arm64-sports-20261114.tar.gz](https://github.com/sproates/zooglass/releases/download/timeline-sports-evidence-20261114/macos-arm64-sports-20261114.tar.gz)                               |    52 |         58,665,716 | `012db06c1c7c537eea65a1eaebe3c55eabde9d4d362f13df068d91e978d822e4` |
| [macos-arm64-timeline-acceptance-20261114.tar.gz](https://github.com/sproates/zooglass/releases/download/timeline-acceptance-evidence-20261114/macos-arm64-timeline-acceptance-20261114.tar.gz) |    52 |          8,152,529 | `394107e12cca91de2002df44b21ac8e8d3f54b2d301922101b6b28a69959b568` |

## Provenance

The original release preserves its archives byte for byte. These commits first
recorded the exact archive bytes; they are distinct from the tested runtime commits:

| Archive     | Archive provenance commit                                                                                                          | Tested source                                                                                                                                                |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| macOS       | [`bc7f8db11e9c4fdb3feb5075ed87447d26158094`](https://github.com/sproates/zooglass/commit/bc7f8db11e9c4fdb3feb5075ed87447d26158094) | Campaign: `3bc584cd61584aec49f9b361803019dd27bf2493`. The archive also includes later clock-leak and bundle evidence, each with its own recorded identities. |
| Linux arm64 | [`b175054e62b1c98296d65615826d70be6ac1db55`](https://github.com/sproates/zooglass/commit/b175054e62b1c98296d65615826d70be6ac1db55) | `1ac7506d13b7ba858a6a47e9c8249048cb6abe15`                                                                                                                   |

The original release tag identifies the storage migration, not a new qualification run.
Earlier commits still contain the archives; this migration does not rewrite Git
history. Keep future large evidence archives in release assets.

The memory lifecycle release targets tested Workbench commit
[`2236a3563c4722a4eda4899445ab9ec30e7e7da7`](https://github.com/sproates/zooglass/commit/2236a3563c4722a4eda4899445ab9ec30e7e7da7).
Its isolated normal/mutant Java hosts were prepared from `397d39a52ea792262b6b5f443a996d41a6efb0e0`.
The archive retains all 60 runs across three memory restart cases, three clock-control
runs, inputs, independent draw vectors, preparation provenance, focused validation
logs, a fresh 108-record replay and the raw-evidence verification report.
See [results and limits](../docs/timeline-memory-qualification.md).

The SQLite release targets tested Workbench commit
[`c5637500fb21f77eaf491067dd774bf295daf2d7`](https://github.com/sproates/zooglass/commit/c5637500fb21f77eaf491067dd774bf295daf2d7).
Its isolated control hosts were prepared from Java source `898aa917e774b0e40bcd365ef2f6ab68858d2ed0`.
The archive retains 60 runs across three abrupt restart cases, three recovery-clock
control runs, exact inputs, preparation provenance, focused validation logs, a
fresh 42-record strict replay and the independent raw-evidence audit and script.
See [SQLite results and limits](../docs/timeline-sqlite-qualification.md).

The fleet release targets tested Workbench commit
[`1724c4ca9b0ed6f3343223d4d9c37bfaa2a3074c`](https://github.com/sproates/zooglass/commit/1724c4ca9b0ed6f3343223d4d9c37bfaa2a3074c).
Its isolated control hosts were prepared from Java source `fa7284c93ea3dc41f726314ca480aef70b891c86`;
the Java tree is unchanged in the tested tooling commit. The archive retains all
20 fleet runs, three strategy-control runs, ordinary-service raw observations,
exact inputs, preparation provenance, focused validation logs, a fresh 432-record
strict replay and the independent raw-evidence audit and script. The audit script
also checks locally retained artifacts; it is not an archive-only replay command.
See [fleet results and limits](../docs/timeline-fleet-qualification.md).

The Order release targets tested Workbench commit
[`e57728977a84060758a6addf70ce1b710162e2d8`](https://github.com/sproates/zooglass/commit/e57728977a84060758a6addf70ce1b710162e2d8).
Its isolated controls use unchanged Java sources from `5ffa2fdba9af3c07b245778a85eb791a43f3383a`.
The archive retains all 15 campaign runs, five actual-runtime control executions,
ordinary-service observations, exact inputs, preparation provenance, validation
logs, five strict baseline replays, a fresh 1,908-record bundle/replay and the
independent audit script/report. The audit also checks locally retained executable
artifacts; it is not an archive-only replay command. Preliminary smoke logs remain
labelled separately from qualification. See [Order results and limits](../docs/timeline-order-qualification.md).

The Sports release targets tested Workbench commit
[`f45cbed3da1b01b22069d294b9535051a672d587`](https://github.com/sproates/zooglass/commit/f45cbed3da1b01b22069d294b9535051a672d587).
Its isolated control uses unchanged Java sources from `bf51047`.
The archive retains all six campaign runs, three actual-runtime control executions,
ordinary-service observations, pinned inputs and independent pre-execution ledger,
validation logs, both portable bundles and strict replays, and the independent
audit script/report. The audit also checks the matching checkout and locally
retained executable artifacts; it is not an archive-only replay command.
See [Sports results and limits](../docs/timeline-sports-qualification.md).

The acceptance release targets candidate
[`9798fab88c1dbb93e2d2dd6ab4db7b7821eedb64`](https://github.com/sproates/zooglass/commit/9798fab88c1dbb93e2d2dd6ab4db7b7821eedb64).
It retains clean macOS setup identities, baseline and correction logs, all eleven
successful CI job logs, a fresh Fleet bundle/replay/comparison, and the aggregate
audit of the seven preceding qualification archives. Local baseline tests ran at
`d17e832`; formatting-only cleanup and a browser-test helper fix preserve runtime
and executor identities. The audit requires the earlier archives at their recorded
workspace paths and matching Git history. It does not rerun their campaigns.
See the [acceptance scope and results](../docs/timeline-acceptance.md). Owner
acceptance and main promotion remain separate decisions.

## Download and verify

Using GitHub CLI, from `workbench/`:

```sh
evidence_dir="$(mktemp -d)"
checksums="$(pwd)/evidence/SHA256SUMS"
gh release download timeline-evidence-20261113 --repo sproates/zooglass --pattern '*.tar.gz' --dir "$evidence_dir"
gh release download timeline-memory-evidence-20261114 --repo sproates/zooglass --pattern '*.tar.gz' --dir "$evidence_dir"
gh release download timeline-sqlite-evidence-20261114 --repo sproates/zooglass --pattern '*.tar.gz' --dir "$evidence_dir"
gh release download timeline-fleet-evidence-20261114 --repo sproates/zooglass --pattern '*.tar.gz' --dir "$evidence_dir"
gh release download timeline-order-evidence-20261114 --repo sproates/zooglass --pattern '*.tar.gz' --dir "$evidence_dir"
gh release download timeline-sports-evidence-20261114 --repo sproates/zooglass --pattern '*.tar.gz' --dir "$evidence_dir"
gh release download timeline-acceptance-evidence-20261114 --repo sproates/zooglass --pattern '*.tar.gz' --dir "$evidence_dir"
(cd "$evidence_dir" && shasum -a 256 -c "$checksums")
python3 scripts/evidence-archive.py verify "$evidence_dir/macos-timeline-20261113.tar.gz"
python3 scripts/evidence-archive.py verify "$evidence_dir/linux-arm64-timeline-20261113.tar.gz"
python3 scripts/evidence-archive.py verify "$evidence_dir/macos-arm64-memory-lifecycle-20261114.tar.gz"
python3 scripts/evidence-archive.py verify "$evidence_dir/macos-arm64-sqlite-restart-20261114.tar.gz"
python3 scripts/evidence-archive.py verify "$evidence_dir/macos-arm64-fleet-20261114.tar.gz"
python3 scripts/evidence-archive.py verify "$evidence_dir/macos-arm64-order-20261114.tar.gz"
python3 scripts/evidence-archive.py verify "$evidence_dir/macos-arm64-sports-20261114.tar.gz"
python3 scripts/evidence-archive.py verify "$evidence_dir/macos-arm64-timeline-acceptance-20261114.tar.gz"
```

The download links also work in a browser. Check the downloaded bytes against
SHA256SUMS before using the archive verifier. It checks the complete per-file
inventory, byte lengths and SHA-256 hashes, consumes the complete bounded gzip
stream (including footer validation), rejects trailing non-padding tar data,
duplicate/unsafe members and links, and enforces byte bounds before tar metadata
parsing. It verifies without extracting or executing the contents. `bundle-cli`
handles portable run directories, not these campaign tarballs.

Hashes establish consistency, not a signature or protection against coordinated
rewriting of both assets and this manifest.

The macOS archive retains the 900-run document campaign, the final 18 clock-leak
controls and mutation recipe, and the portable bundle plus its replay report.
Each original run retains its inputs, trace, identities, environment and timing
observations. The older summary hashes still match the published reports.

The Linux archive retains the complete 900-run matrix, test/campaign/preparation
logs, image metadata and Dockerfile. See the [results](../docs/timeline-linux.md).

The original prepared JARs are retained locally, not included in these archives.
Matching executable/environment identities remain required for replay; archived
evidence alone is not an executable environment. Each archive qualifies only its
recorded scope; none implies identical outputs across operating systems.

To create another archive, pass a new output path followed by evidence sources:

```sh
python3 scripts/evidence-archive.py pack NEW_ARCHIVE.tar.gz SOURCE_DIRECTORY [MORE_SOURCES...]
python3 -m unittest discover -s test -p evidence_archive_test.py
```

Packing preserves exact file bytes with fixed archive metadata, excludes no files,
and rejects symlinks. Review source contents before publishing an archive.
