# SQLite recovery-clock negative control

The [SQLite rollback scenario](../scenarios/simulation/sqlite-wall-rollback.json)
commits a receipt at wall time `E + 10`, then restarts at global time 21 with the
wall clock set to `E + 6`. Production recovery reads the installed wall clock
and exposes `ageUnknown`, version 2, with a null receipt timestamp and no alarm.

The mutant computes runtime wall time as `E + T`, ignoring the controlled
offset. It recovers the same contribution as `fresh`, version 1, with the
original receipt timestamp and an alarm due at global time 60. The generation's
acknowledged initialization still reports wall `E + 6` and monotonic zero. The
checker requires the mutant to reach and fail `unknown-after-recovery`.

From `workbench/`, use JDK 25, Node 26 and Python 3.12 or later on macOS or Linux.
Both output directories must be new.

```sh
npm run prepare:generation-clock-control -- --recovery /tmp/recovery-clock-prepared
npm run timeline:generation-clock-control -- --recovery /tmp/recovery-clock-prepared /tmp/recovery-clock-evidence
```

Preparation builds the committed Java code in isolation. Both hosts embed the
same production runtime, and their compiled classes differ only in
`ControlledReceiptClock`. The checker verifies JAR, class, embedded runtime,
source and recipe identities before launch. Checking and tests use prepared
artifacts without invoking Maven.

The checker retains the passing normal run and both complete wrong traces. The
second mutant run requests 70 ms Node delays and 90 ms JVM pauses and must
produce the same wrong trace. The checker observes a JVM pause during the
initial publication and a Node delay before the replacement host's recovery.
The summary identifies the first differing record and the failed assertion.
Each run starts with freshly allocated empty SQLite storage. Failed runs retain
local database diagnostics separately from the semantic evidence directory.
