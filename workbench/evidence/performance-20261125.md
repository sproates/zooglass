# Performance evidence, 25 November 2026

Publication status: prepared for review. The Release is a draft until the report
and evidence are approved; download links below become public on publication.

The [scoped findings](../docs/performance-baseline-20261125.md) describe the passed
100/s comparison and its limits. Earlier unsuccessful runs are retained alongside
it. These are ordinary service performance measurements, separate from the
deterministic timeline evidence in this directory.

Release: [performance-evidence-20261125](https://github.com/sproates/zooglass/releases/tag/performance-evidence-20261125),
targeting tested source `3df4c480e1081e513ab53812d582068e9da8d0eb`.
The archive names retain their original dates; earlier archives identify earlier
producing revisions below. The documentation commit is not the measured source.

| Archive                                                                                                                                                                     | Purpose                         | Producing source            | SHA-256                                                            |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | --------------------------- | ------------------------------------------------------------------ |
| [zooglass-performance-20261124.tar.gz](https://github.com/sproates/zooglass/releases/download/performance-evidence-20261125/zooglass-performance-20261124.tar.gz)           | Original wider campaign         | `c7502fe`                   | `d69fabdda7ebee9ed2e955369738afcad1fee9137c32b5e2e738e2b9fdb46844` |
| [zooglass-sampling-20261124.tar.gz](https://github.com/sproates/zooglass/releases/download/performance-evidence-20261125/zooglass-sampling-20261124.tar.gz)                 | Paired sampling diagnostic      | `bbabafd`                   | `03dad9c2af3826f0213ff02d0f25dd0976c8fc4babdea7669f7f8146d57a9bd4` |
| [zooglass-isolated-20261124.tar.gz](https://github.com/sproates/zooglass/releases/download/performance-evidence-20261125/zooglass-isolated-20261124.tar.gz)                 | Isolated sampler diagnostic     | `d81697c`                   | `70483616348ed22e83a205e6e18446d0280f1611a192e2e98c120e6e5e2b9884` |
| [zooglass-deadline-20261125.tar.gz](https://github.com/sproates/zooglass/releases/download/performance-evidence-20261125/zooglass-deadline-20261125.tar.gz)                 | Deadline pacing diagnostic      | `3df4c48`                   | `ddb3437e06a8e20e1b2545b07f1959eb065242f126875aa5e4fa8d6fb9686988` |
| [zooglass-service100-20261125.tar.gz](https://github.com/sproates/zooglass/releases/download/performance-evidence-20261125/zooglass-service100-20261125.tar.gz)             | Six-run real-service comparison | `3df4c48`                   | `96776b7693d160695dd5b3b1f9835df9501d3022b1120715331c4d50b8fb09ba` |
| [zooglass-service100-audit-20261125.tar.gz](https://github.com/sproates/zooglass/releases/download/performance-evidence-20261125/zooglass-service100-audit-20261125.tar.gz) | Portable offline audit          | Post-run audit of `3df4c48` | `91580ac2162301c40e1ede4b97c3da90a09eb0a43f46d68055870d51ec9bbf6e` |

The raw service comparison archive includes the exact `compare-service.mjs`
wrapper and its original host-specific launcher, six attempt directories,
completion inventories, input files, observations, resource samples and stopped
SQLite stores. No service binary is included. Treat the launcher as a record of
the measured setup, not a portable command to run unchanged.

## Verify the retained result

Download the service comparison and audit companion assets into an empty directory.
Use [performance-20261125.sha256](performance-20261125.sha256) from this repository
to check their SHA-256 before extracting. The file also pins the earlier archives;
check each downloaded filename against its corresponding line.

After extracting both archives into the same directory, run:

```sh
python3 public-audit/audit-service.py evidence/service100-comparison
```

The companion README gives the full verification scope. It uses
Python's standard library and SQLite, needs no Java build or running service, and
checks the measured protocol, input/artifact inventories, raw observations and
stopped stores. Its pinned identity file preserves the comparison with the earlier
deadline run. Checksums establish byte identity, not an independent signature.

To repeat measurements, use the producing source, prepare dependencies and the
service explicitly, and adapt the retained launcher paths to an otherwise idle
host. Preserve the workload, durations, heap settings, storage mode and recorded
conditions. Repeated latency and CPU values will vary; offline re-auditing of the
retained bytes is distinct from reproducing performance on another host.
