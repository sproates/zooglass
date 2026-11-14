# Runtime generation foundation

The private host protocol supports fresh memory and SQLite runtime generations. The
[document lifecycle executor](timeline-lifecycle.md) now uses this foundation for
v2 memory stop/start actions, downtime retries and recorded/replayed evidence.
SQLite documents now integrate private store ownership, snapshot assertions and
fresh-store replay; see [SQLite timeline documents](timeline-sqlite.md).

## Clock and process ownership

`RuntimeGenerations` owns one active JVM and an immutable handle for its generation.
Generation 1 starts at global time zero; each later start launches a fresh JVM.
For global time `T`, generation start `S` and fixed epoch `E`, the runtime reads
monotonic time `T − S` and wall time `E + T + A`, where A defaults to zero and
changes only through [explicit wall settings](timeline-wall-clock.md). Alarms remain scheduled at global
`T + delay`. Clocks are installed before constructing the production runtime.
No elapsed process startup or shutdown time contributes to these values.

Commands require the active generation handle. A handle from an earlier generation
cannot dispatch a callback into a replacement, even when both hosts allocate the
same task number. The owner keeps command IDs and a bounded command budget across
starts, caps generations at 16 and rejects backwards global time. Artifact and
JVM environment identity must remain the same across generations.

Orderly stop acknowledges the runtime's `shutdown` turn, closes stdin and verifies
normal process exit. Abrupt stop kills the process after an acknowledged turn and
verifies the expected termination. Neither permits an unexpected process failure
to become a successful modelled stop. Failed execution is terminal; force cleanup
does not count as a simulated stop or permit restarting the failed run.

## Private protocol admission

Protocol 1 keeps its memory execution, handshake and environment unchanged. Its
metadata inspection now identifies eligible SQLite configurations for protocol 2. Selecting protocol 2 requires the host handshake capability
`memoryLifecycle:1`; its `documentFormats` is empty. The first command is
`initialize-document`, carrying configuration, epoch and generation start, with
explicit generation, global turn ID and all three clock coordinates. Subsequent
command IDs are consecutive. Every response echoes the generation and clocks.
Protocol 2 does not offer configuration inspection; existing v1 preflight remains
separate. Workbench admits public v2 documents through its lifecycle executor and
explicit host capability probe, rather than the host documentFormats list.

## Verification

After explicitly running `npm run prepare:timeline`, run:

```sh
node --import tsx --test test/timeline/generations.test.ts test/timeline/bridge-completion.test.ts
```

The real-host tests check orderly and abrupt replacement, memory identity reset,
receipt wall timestamps, freshness deadlines, same-time restart, global command
budgets and long host pauses. Pipe tests check invalid acknowledgments and process
completion failures. Tests consume the prepared JAR and never build Java.

The document lifecycle suite separately covers generation-qualified tasks and
connections, external retry continuity and v2 evidence. Broader repeated lifecycle
qualification remains separate from these direct process-boundary tests.

## SQLite host foundation

Protocol 2 advertises `sqliteLifecycle:1`, `storage:["memory","sqlite"]` and
`environment.sqliteVersion` when the native SQLite metadata probe succeeds.
The probe uses an isolated in-memory connection; it opens no scenario database.
Without native SQLite, memory remains available and SQLite is not advertised.
Protocol 1's handshake and environment remain unchanged.

A direct `RuntimeGenerations` caller supplies an absolute `database` path inside
its own private directory and an optional ordered `observationTargets` array of
at most 64 distinct `{viewId, entityId}` pairs. The same database survives that
owner's stops and starts; a missing database on replacement is an error. Direct
callers may supply an existing generation-1 store, but document fixture import is
not admitted. The caller owns allocation, cleanup and diagnostic
retention; this low-level API does not admit arbitrary database paths in scenario
files. SQLite configuration, native capability and targets are validated before
opening the database. Memory and protocol 1 reject database parameters.

Initialization returns one opaque snapshot wire string per target, in declaration
order. Known views with absent entities return their version-zero snapshot;
unknown views reject initialization. The adapter reads production installed state
without sampling clocks, expiring values, scheduling work or committing storage.
Recovery runs first with the generation's clocks already installed. Recovery
snapshots are separate from state callbacks; any returned alarms retain global
agenda deadlines. Durable duplicate receipts retain their original version and
targets, even when recovery has advanced the current view's freshness/version.

The owner pins full protocol-2 environment identity across generations. An initial
memory comparison against protocol-1 preflight excludes only the new SQLite-version
field, then pins the complete identity. SQLite callers supplying an expected
environment must include the admitted native version. Failed startup or unavailable
storage is a terminal infrastructure failure; the owner never silently substitutes
memory or reopens after failure, and it does not remove diagnostic database files.

Run the direct prepared-host SQLite checks with:

```sh
node --import tsx --test test/timeline/sqlite-generations.test.ts
```

These direct checks exercise ordinary and abrupt recovery, remaining freshness, deadline
ties, stale recovery, durable duplicate receipts, target ordering, failed startup
and long host pauses. The document suite separately checks SQLite execution and replay. These direct
checks do not qualify wall-clock adjustments, mid-commit crashes or physical durability.
