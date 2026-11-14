# SQLite timeline documents

`timeline-simulation/v2` can start with an empty SQLite store and restart the
real production runtime under controlled generation clocks. The profile remains
bounded to one source, view and receipt-age field. Protected access, imported
storage fixtures are not admitted. [Controlled wall-clock adjustments](timeline-wall-clock.md)
are available in v2.

From `workbench/`, after explicitly preparing the host:

```sh
npm run timeline:execute -- scenarios/simulation/sqlite-restart.json /tmp/sqlite-run.json
npm run timeline:replay -- /tmp/sqlite-run.json /tmp/sqlite-replay.json --require-passed
npm run timeline:bundle -- record scenarios/simulation/sqlite-restart.json /tmp/sqlite-bundle
```

The example commits at 10, stops abruptly at 11, observes unavailability at 15,
and restarts at 50. Recovery installs stale version 2 before ordinary commands.
The retry returns the original version-1 durable receipt with `alreadyCommitted`;
it does not refresh the recovered value's age. SQLite's initial receipt is
`committed`/`sqlite`, distinct from memory's `applied`/`memory`.

## Declared observations

Declare up to 64 unique `{viewId, entityId}` pairs in `observationTargets`.
Initialization records their installed snapshots in declaration order, including
version-zero snapshots for absent entities in a known view. Unknown views reject
admission before any writable store is created.

An actorless `runtime-snapshot` assertion has `id`, `atMs`, `viewId`, `entityId`
and `expected`. Its target must be declared. Expected values have one of two forms:

```json
{ "outcome": "runtime-unavailable" }
```

or `{ "outcome": "available", "snapshot": <complete installed snapshot> }`.
The example contains complete literal expectations. Installed snapshots retain
contribution wrappers (`publicationSequence` and `payload`) in their data; client
frames keep their existing flattened presentation.

A running observation reads installed state without clock samples, expiry,
scheduling or storage writes. It cannot repair a missing recovery transition.
A stopped observation creates no JVM and returns no cached snapshot. The trace
binds each assertion to its actual observation, target, generation and agenda
position. Replay also checks its ID, time and literal expectation against the
retained scenario before executing it.

## Store and evidence lifetime

Complete scenario/configuration, native capability, target and replay-environment
admission precedes database allocation. Each execution gets a new private temporary
directory. It reuses that database only within its own generations, after the old
process has exited. A missing database on restart is an infrastructure failure.
Paths, SQLite pages, WAL bytes and filesystem timing are not semantic outputs.

A successful execution closes and removes its store. Assertion, limit and execution
failures retain a diagnostic directory in `diagnostics.retainedStore`; database
presence is recorded when available. Inspect or remove those local directories
when diagnosis is complete. Store cleanup failure produces incomplete evidence,
not a passing terminal record. A later failure publishing evidence cannot restore
an already removed successful store.

Portable bundles contain inputs, traces, identities and reports, never databases.
Bundle recording always uses an independent temporary store. Replay creates a new
empty database and re-executes all inputs; it never reads the original final store.
SQLite's actual native version is part of the recorded environment and must match.
An older host lacking `installedObservations:1` rejects documents requiring runtime
observations before allocating storage. Tests and execution never build Java.

The tests cover ordinary and abrupt restarts before/at/after expiry, durable
receipts, same-time recovery and new input, long host pauses, failed startup,
cleanup failure, altered evidence and fresh-store replay. Complementary production
SQLite crash/recovery tests remain necessary: between-turn stops do not model
mid-commit crashes, torn writes or physical power loss.
