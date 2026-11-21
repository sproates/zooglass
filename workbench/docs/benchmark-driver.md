# Single-execution performance driver

The driver checks the measurement path defined by the
[single-instance performance plan](../../docs/design/single-instance-performance.md).
It offers changing publications to a real ZooGlass process, checks every expected
receipt and viewer update, and verifies final snapshots. This first increment does
not implement campaign selection, resource sampling, percentiles or sustainable-rate
classification. A completed execution is not a capacity claim.

From `workbench/`, explicitly prepare the service before running:

```sh
npm run prepare:service
npm run benchmark:run -- memory 10 /absolute/path/new-execution
```

Use `sqlite` for a new temporary durable store. Supported diagnostic rates are
10, 30, 100, 300 and 1000/s. The output directory must not already exist. Each
execution seeds the fixed resident state, warms for 30 seconds, measures for
120 seconds and drains for at most 10 seconds. It uses the baseline workload;
the frozen multi-execution campaign will be a separate command.

`run.json` records configuration, planned slots, submissions, unsent slots,
per-phase receipt/fan-out accounting, driver buffer high-water marks and any
failure. `observations.jsonl` contains bounded callback timestamps and identities,
written after measurement. These are diagnostic records, not signed evidence or
a qualified benchmark result. An early startup failure leaves `failure.json`.
Never compare service versions using these files without recording the exact
artifacts and environment; campaign identity and result publication are still pending.

Missed send slots are retained in the denominator and never sent as a catch-up
burst. The driver uses a monotonic client clock and matches updates even if they
arrive before receipts. Missing responses remain outstanding; malformed, duplicate
or incorrect responses stop the execution and retain diagnostics. Source and
viewer work are checked separately. Sender, observation and time limits stop work
explicitly. Cancellation closes sockets and the owned service.

Exit 0 means execution completed with its receipt/view checks, not that latency or
offered-load budgets passed. Exit 2 means execution failed with retained accounting.
Exit 1 means invalid arguments, startup or output failure. Inspect missed slots
and the recorded failure, not just the exit code. No tests or driver runs compile Java.
