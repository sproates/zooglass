# Retained timeline evidence

These compressed archives retain raw qualification evidence in Git history,
alongside their published results. They are deliberate evidence assets, not
generated build output. They contain no executables or dependencies.

Verify an archive without extracting it, from `workbench/`:

```sh
python3 scripts/evidence-archive.py verify evidence/macos-timeline-20261113.tar.gz
```

The verifier checks its complete per-file inventory, byte lengths and SHA-256
hashes, consumes the complete bounded gzip stream (including footer validation),
rejects trailing non-padding tar data, duplicate/unsafe members and links, and
enforces byte bounds before tar metadata parsing.
The printed archive hash can be compared with the table below. Hashes establish
consistency, not a signature or protection against coordinated rewriting.

| Archive                                | Files | Uncompressed bytes | SHA-256                                                            |
| -------------------------------------- | ----: | -----------------: | ------------------------------------------------------------------ |
| `macos-timeline-20261113.tar.gz`       |   937 |         49,428,333 | `39b7cdc54d190e65c54e8e6422663101c24b90533b38c05de6e792953008f558` |
| `linux-arm64-timeline-20261113.tar.gz` |   916 |         49,915,765 | `3440a2bda91cd51dd4a149db12e19516ec8c9cdb3926f51d6cd8e065d4baa4ff` |

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
