# PostgreSQL storage foundation

PostgreSQL storage is an internal foundation for the accepted
[clustering design](../../docs/design/clustering-high-availability.md).
Public service configuration still rejects `storage: postgresql`. This slice
provides storage and recovery tests, not a deployable clustered service.

The internal `ha-static-v1` profile admits up to three sources, two views and four
fields in total, with at most three fields per view. It supports arrival,
latest-by-sequence and bounded history, envelope entity mappings, source priority
and required contributions. Freshness must be unspecified and progress untracked.
Facts, retirement and runtime registration are unavailable. Unsupported settings
are rejected before opening a database connection.

## State and recovery

One runtime occupies one database schema. Its immutable binding includes runtime
identity, tenant and canonical configuration, including delivery settings. Recovery
rejects a different binding or an invalid persisted image.

Each transaction stores a complete typed state image, including hidden candidates,
provenance, histories, retained receipts and sequence floors. It checks the previous
revision and commits before replacing the local cache. Receipts report PostgreSQL
persistence. A failed or uncertain commit invalidates that cache; reopening the store
and retrying resolves whether the original publication committed.

The initial implementation rewrites the whole image per commit. This makes state
preservation explicit but makes write cost grow with retained state. No throughput
or scaling claim follows. Revision checks prevent stale installation; they are not
ownership leases or permission to serve clients. Those gates remain future work.

## Run the database checks

Prepare Java artifacts explicitly, then run the fixture script from `zooglass/`:

```sh
./mvnw --batch-mode -DskipTests package
python3 scripts/test-postgresql.py
```

The script requires Docker, uses a unique container and a loopback-only ephemeral
port, and removes its container and volumes afterwards. It invokes Surefire on
prepared classes and never builds Java. CI runs the same check after its normal
Java preparation and tests. Missing fixture configuration fails the explicit
integration suite rather than silently skipping it.

The fixture pins PostgreSQL 18.7 on Bookworm by immutable multi-platform digest;
the runtime dependency is pgJDBC 42.7.15. See the
[PostgreSQL releases](https://www.postgresql.org/support/versioning/) and
[driver releases](https://jdbc.postgresql.org/). The exact image is recorded in
[`test-postgresql.py`](../scripts/test-postgresql.py).

The database suite exercises recovery, duplicate receipts, hidden candidates,
rollback, a lost commit acknowledgement, conflicting revisions and corrupted
images. These are real database tests. They do not establish failover, client
continuity, database replication or deterministic multi-node simulation.
