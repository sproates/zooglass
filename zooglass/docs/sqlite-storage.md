# SQLite storage

SQLite lets ZooGlass retain v2 views and publication identities across a service
restart. A retried publication remains a duplicate after recovery, and delayed
events use the restored ordering state.

## Enable it

In your [v2 configuration](v2-ingestion.md), change `"storage": "memory"` to
`"storage": "sqlite"`. Start the built service with a database path:

```sh
java -jar target/zooglass.jar \
  --zooglass.v2.config=file:/absolute/path/v2.json \
  --zooglass.v2.database=/absolute/local/directory/zooglass.sqlite
```

The parent directory must already exist. ZooGlass creates a new database if the
file is absent. Use a local filesystem and one service instance per database.
A second owner fails to start. Do not remove or copy the database's WAL files
while the service is running.

Memory mode remains the default. Existing legacy endpoints and demo state do not
use this database.

## What survives a restart

One transaction saves the publication identity, retained sequence floor, affected
view values and commit version. Source contracts and view definitions are also
stored. ZooGlass restores and validates them before accepting requests.

- New publications return `status: committed`, `reason: sqlite`.
- Retained retries return `status: duplicate`, `reason: alreadyCommitted`,
  with the original commit version.
- Conflicts, expired identities and capacity limits retain the v2 rejection rules.
- A lost acknowledgement does not undo a commit. Resend the same publication.

Startup configuration may reorder definitions or add sources and views. Existing
definitions, source epochs and capacity limits must remain unchanged. Removing or
changing them fails startup. A new view starts empty; retrying old publications
does not backfill it.

## Storage failures

An unavailable database, unknown schema, incompatible configuration or invalid
recovered state prevents startup. ZooGlass never silently switches to memory.

A write or commit failure stops v2 reads and writes and makes the service health
check report DOWN. The source receives a processing failure, not a committed
acknowledgement. Resolve the storage problem and restart to recover the database's
actual committed state, then retry.

This deliberately treats even a successfully rolled-back write failure as requiring
restart. It avoids continuing when the commit result could be uncertain.

## Implementation and verification

The store uses SQLite WAL with `synchronous=FULL` and exclusive connection
ownership. Automatic checkpoints run at 1000 WAL pages; unused WAL space is
limited to 4 MiB when reset. Stream and history admission limits bound retained
entry counts, not total bytes. Changed streams and views are written separately,
so each event does not rewrite every entity.

The pinned [Xerial JDBC driver 3.54.1.0](https://github.com/xerial/sqlite-jdbc/releases/tag/3.54.1.0)
bundles SQLite 3.54.1. SQLite documents its
[synchronisation settings](https://sqlite.org/pragma.html#pragma_synchronous)
and [local-host WAL requirements](https://sqlite.org/wal.html).

Tests cover orderly service restart through real HTTP/WebSocket endpoints,
retained retries and floors, delayed events, conflicting startup definitions,
exclusive ownership, corrupted state and rollback after a partial transaction.
Process termination at commit and acknowledgement boundaries is the next
acceptance slice. Storage guarantees depend on functioning filesystem sync.
