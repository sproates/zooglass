# Retained timeline evidence

Raw qualification archives are downloadable assets of the
[timeline-evidence-20261113 release](https://github.com/sproates/zooglass/releases/tag/timeline-evidence-20261113).
Git retains this manifest and [SHA256SUMS](SHA256SUMS). The archives contain no
executables or dependencies. Release assets remain available until explicitly
changed or deleted; their hashes below pin the exact published bytes.

| Archive                                                                                                                                                        | Files | Uncompressed bytes | SHA-256                                                            |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----: | -----------------: | ------------------------------------------------------------------ |
| [macos-timeline-20261113.tar.gz](https://github.com/sproates/zooglass/releases/download/timeline-evidence-20261113/macos-timeline-20261113.tar.gz)             |   937 |         49,428,333 | `39b7cdc54d190e65c54e8e6422663101c24b90533b38c05de6e792953008f558` |
| [linux-arm64-timeline-20261113.tar.gz](https://github.com/sproates/zooglass/releases/download/timeline-evidence-20261113/linux-arm64-timeline-20261113.tar.gz) |   916 |         49,915,765 | `3440a2bda91cd51dd4a149db12e19516ec8c9cdb3926f51d6cd8e065d4baa4ff` |

## Provenance

The release preserves the original archives byte for byte. These commits first
recorded the exact archive bytes; they are distinct from the tested runtime commits:

| Archive     | Archive provenance commit                                                                                                          | Tested source                                                                                                                                                |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| macOS       | [`bc7f8db11e9c4fdb3feb5075ed87447d26158094`](https://github.com/sproates/zooglass/commit/bc7f8db11e9c4fdb3feb5075ed87447d26158094) | Campaign: `3bc584cd61584aec49f9b361803019dd27bf2493`. The archive also includes later clock-leak and bundle evidence, each with its own recorded identities. |
| Linux arm64 | [`b175054e62b1c98296d65615826d70be6ac1db55`](https://github.com/sproates/zooglass/commit/b175054e62b1c98296d65615826d70be6ac1db55) | `1ac7506d13b7ba858a6a47e9c8249048cb6abe15`                                                                                                                   |

The release tag identifies the storage migration, not a new qualification run.
Earlier commits still contain the archives; this migration does not rewrite Git
history. Keep future large evidence archives in release assets.

## Download and verify

Using GitHub CLI, from `workbench/`:

```sh
evidence_dir="$(mktemp -d)"
checksums="$(pwd)/evidence/SHA256SUMS"
gh release download timeline-evidence-20261113 --repo sproates/zooglass --pattern '*.tar.gz' --dir "$evidence_dir"
(cd "$evidence_dir" && shasum -a 256 -c "$checksums")
python3 scripts/evidence-archive.py verify "$evidence_dir/macos-timeline-20261113.tar.gz"
python3 scripts/evidence-archive.py verify "$evidence_dir/linux-arm64-timeline-20261113.tar.gz"
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
evidence alone is not an executable environment. This does not qualify persistence
or imply identical outputs across operating systems.

To create another archive, pass a new output path followed by evidence sources:

```sh
python3 scripts/evidence-archive.py pack NEW_ARCHIVE.tar.gz SOURCE_DIRECTORY [MORE_SOURCES...]
python3 -m unittest discover -s test -p evidence_archive_test.py
```

Packing preserves exact file bytes with fixed archive metadata, excludes no files,
and rejects symlinks. Review source contents before publishing an archive.
