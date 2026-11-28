# PostgreSQL storage and ownership foundations

PostgreSQL storage supports the integration branch
[HA service profile](ha-service.md), under the accepted
[clustering design](../../docs/design/clustering-high-availability.md).
Standalone service configuration still rejects `storage: postgresql`; explicit
HA deployment settings are required. The [finite failover qualification](../../workbench/docs/ha-qualification.md)
passed on its review branch; integration merge and main promotion remain pending.

The `ha-static-v1` profile admits up to three sources, two views and four
fields in total, with at most three fields per view. It supports arrival,
latest-by-sequence and bounded history, envelope entity mappings, source priority
and required contributions. Freshness must be unspecified and progress untracked.
Facts, retirement and runtime registration are unavailable. Unsupported settings
are rejected before opening a database connection.

## State and recovery

One runtime occupies one database schema. Its immutable binding includes runtime
identity, tenant and canonical configuration, including delivery settings. Recovery
rejects a different binding or an invalid persisted image.

Each state commit stores a complete typed image, including hidden candidates,
provenance, histories, retained receipts and sequence floors. It checks the previous
revision and commits before replacing the local cache. Receipts report PostgreSQL
persistence. A failed or uncertain commit invalidates that cache; reopening the store
under a new attempt and retrying resolves whether the original publication committed.

The initial implementation rewrites the whole image per commit. This makes state
preservation explicit but makes write cost grow with retained state. No throughput
or scaling claim follows.

## Ownership and output admission

The authority and image share one locked runtime row. Each acquisition records a
fresh attempt and advances the generation before recovering state. The runtime
becomes active only after reconstruction and a checked activation. An expired
attempt must acquire a new generation and recover; renewal cannot revive it.
The internal lease argument accepts whole milliseconds from 1 to 300,000.
Database sessions bound lock waits to 3 seconds, statements to 10 seconds and
idle transactions to 10 seconds. These bounds are exercised locally; they are
not a production takeover-time promise.

Transactions sample database time after acquiring the row lock. New mutations,
renewals and output permits check the current attempt, generation and lease. A
connection failure, revision conflict or uncertain transaction invalidates the
local attempt. Reusing its cache is not a recovery mechanism.

New snapshot captures require the local global revision to match the database.
An immutable frame captured by the same owner at revision 7 can still be admitted
after revision 8 commits. Its content revision stays 7; the permit separately
records the revision checked at handoff. The original view or receipt version is
unchanged. Permits are bound to captured content and cannot be reused.

The internal API returns opaque captures, including for new committed receipts.
A separate checked handoff supplies immutable response bytes and authority
metadata to a callback outside runtime and database locks. Even a new receipt
therefore receives a fresh handoff check; capture alone does not expose its bytes.
A failed callback does not make that capture reusable.

These internal checks authorise admission, not arrival at a remote client. A
process can pause after permission is granted, so previously admitted bytes may
arrive after takeover. The [HA wire protocol](../../docs/design/ha-client-protocol.md),
[reference client](../../workbench/docs/ha-client.md) and protected readiness handle
that distinction on the integration branch. The [finite fault qualification](../../workbench/docs/ha-qualification.md) passed
on its review branch; integration merge and main promotion remain pending. Standalone
HTTP and WebSocket paths cannot construct this PostgreSQL runtime.

The internal schema is version 2. Version 1 fixtures from the earlier storage-only
slice are rejected; there is no automatic migration or destructive reset. This
is an integration-stage format change, not support for rolling upgrades.

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
images. Ownership checks add competing acquisitions, stale entry points, exact
generation counters, uncertain authority commits, single-use handoff and actual
server-side timeout cases. These are real database connection tests. They do not
establish two-process failover, client
continuity, database replication or deterministic multi-node simulation.
