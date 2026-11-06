# SQLite storage

SQLite lets ZooGlass retain views and publication identities across a service
restart. A retried publication remains a duplicate after recovery, and delayed
events use the restored ordering state.

Upgrading an existing deployment requires renaming `zooglass.v2.config` and
`zooglass.v2.database` to `zooglass.config` and `zooglass.database`. Keep the
configured database path. Startup reports retired settings before opening storage.

## Enable it

In your [configuration](publications.md), change `"storage": "memory"` to
`"storage": "sqlite"`. Start the built service with a database path:

```sh
java -jar target/zooglass.jar \
  --zooglass.config=file:/absolute/path/views.json \
  --zooglass.database=/absolute/local/directory/zooglass.sqlite
```

The parent directory must already exist. ZooGlass creates a new database if the
file is absent. Use a local filesystem and one service instance per database.
A second owner fails to start. Do not remove or copy the database's WAL files
while the service is running.

Memory mode remains the default. All interfaces use the configured store;
Workbench starts isolated memory-mode sessions for its scenarios.

## Tenant ownership

The store now supports the [view-access contract](../../docs/design/view-access.md).
A bound database records its tenant before any state is restored. Opening it for
another tenant fails, even if both tenants use the same view and entity IDs.
Open demo mode also refuses bound databases.

**Protected serving is not enabled yet.** The tenant-aware store entry point is
internal until admission and active revocation are implemented. Existing unowned
demo databases continue to work. Do not adopt a demo database you need to keep
using with the current server.

To prepare an existing database for protected use:

1. Stop ZooGlass and verify which tenant owns the stored data.
2. Take a backup of the stopped database.
3. Run the offline command:

   ```sh
   java -jar target/zooglass.jar adopt-store /absolute/path/zooglass.sqlite tenant-a
   ```

The command does not start a server. It validates the existing configuration and
state under an exclusive transaction, then records the owner. It refuses missing
files, invalid state, a running database owner or a different recorded tenant.
Repeating it for the same tenant is harmless. Startup never adopts an existing
unowned database implicitly, including an initialised database with no events.

Ownership uses schema 7 with a separate data-schema marker for schemas 4–6.
Later data migrations preserve ownership. Older binaries reject schema 7; use
the pre-adoption backup to return to unowned demo mode. Ownership is a deployment
check, not encryption or protection against someone who can edit the database.

## What survives a restart

One transaction saves the publication identity, retained sequence floor, affected
source-local candidates (including hidden updates), selected view values, field
provenance, original target/field outcomes, source progress ranges, watermark
retry versions, violation flags and commit version. Source contracts and view
definitions are also stored. ZooGlass restores and validates them before accepting requests.

- New publications return `status: committed`, `reason: sqlite`.
- Retained retries return `status: duplicate`, `reason: alreadyCommitted`,
  with the original commit version and target outcomes.
- Conflicts, expired identities and capacity limits retain the rejection rules.
- A lost acknowledgement does not undo a commit. Resend the same publication.

Startup configuration may reorder definitions or add sources and views. Existing
definitions, source epochs and capacity limits must remain unchanged. Removing or
changing them fails startup. A new view starts empty; retrying old publications
does not backfill it.

## Schema migration

Storage schema 4 adds progress and field outcomes. Schema-1, schema-2 and schema-3 databases
migrate transactionally before readiness. Existing field values, publication
identities, retention floors, target outcomes and versions are preserved. Each
old single-source value seeds its candidate without replay; schema 1 also gains
provenance from its envelope-based definitions.

Old receipts return `targets: null`: schema 1 did not record those outcomes.
New receipts store an array. Migration failure leaves the original schema and
rows intact and stops startup. Unknown schemas are rejected; older binaries
reject schema 4, so this is not an automatic downgrade path.

Equivalent single-input shorthand/expanded field forms and explicit/default
envelope resolvers normalise before configuration comparison. Lookup mappings
remain immutable for each view ID. Recovery checks every candidate against its configured resolver and retained
source stream, recomputes the selected winner to validate data/provenance, and
validates recorded target outcomes before serving requests. Input ordering is
normalised; source-priority ordering remains significant.

Existing sources normalise to untracked progress: retained receipts cannot establish
an earlier contiguous promise. Historical target records gain `fields: null`, while
schema-1 receipts still have `targets: null`. Migration preserves versions and data.
A control-only stream may have no data receipts; its watermark receipt and range
state are retained. Recovery validates ranges, source contracts and field outcomes.

## Storage failures

An unavailable database, unknown schema, incompatible configuration or invalid
recovered state prevents startup. ZooGlass never silently switches to memory.

A write or commit failure stops reads and writes and makes the service health
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
Force-kill tests also cover partial writes, the boundary before commit, the
boundary after commit but before acknowledgement, and termination after the
acknowledgement is received. Each restarts the actual service and checks snapshots
and retries. See the [verification guide](../../docs/testing.md#abrupt-process-termination).
Storage guarantees still depend on functioning filesystem sync; these tests do
not simulate power loss or defective hardware.

Required-field views retain their candidates and exposed data in the existing
schema-4 view row. Recovery checks that waiting rows expose no data or provenance,
recomputes required-field presence and validates the configured pending limit.
Default-only configurations retain the previous schema-4 encoding, including when
`publishPartial` is selected explicitly. The preceding schema-4 binary can reopen
that database with its original configuration. Once a required view is configured,
older binaries cannot read its policy; use a pre-upgrade backup to roll back.

## Receipt age and restart

Selecting receipt age upgrades storage to schema 5 in a startup transaction.
Configurations using only unspecified freshness continue to write schema 4.
Keep a pre-upgrade backup to return to a previous binary after opting in.

Each timed candidate retains its own receipt evidence. Data, controls and expiry
commits record the greatest wall time observed. While running, ZooGlass measures
elapsed time on a monotonic clock. At startup it accounts for downtime and
reconciles due fields before serving snapshots. If the wall clock has gone
backwards, previously timed candidates become age-unknown until replaced.
A retry retains its original receipt and version across an expiry commit.

ZooGlass compares wall time with monotonic elapsed time at commits. This detects
a backwards adjustment even when the new wall reading exceeds the previous one.
If the readings establish a backwards step, ZooGlass marks earlier receipts
in that same transaction. Their running deadlines still use monotonic time.
On restart those receipts become age-unknown even if wall time has caught up.
Schema upgrade, configuration and startup age reconciliation commit together.
If the initial clock write fails, the previous configuration can reopen the database.

## Retained facts

[Fact-enabled configurations](fact-collections.md) use schema 6. Field records,
tombstones, retirement floors, projections and fact metadata in publication
receipts commit together. A floor may survive without a present contribution.
Recovery validates records and recalculates projections before readiness.
Non-fact configurations retain their schema-4/5 encoding.
