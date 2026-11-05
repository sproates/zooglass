# One ZooGlass runtime

ZooGlass has no external compatibility obligation that justifies maintaining two
stores and ingestion paths. Consolidate on the identity-aware coordinator and
its memory/SQLite storage, keeping the existing strategy modules.

## Contract and ownership

- One `/events` publication endpoint, `/progress` and `/facts/retire` controls,
  `/views/{viewId}/{entityId}` snapshots, `/views/live` subscriptions, and
  `/views` registration endpoint. Remove `/v2` aliases and the old event store.
- Use explicit publication identity (source, epoch, entity and publication
  sequence). Retain acknowledgements, atomic installation, recovery and configured
  strategies. Workbench producers create identities; the service owns reconciliation.
- Move the version-named Java package to `runtime`, and use purpose-based names
  for configuration, endpoints and storage health. Wire/schema version numbers
  remain explicit where they describe data rather than parallel implementations.
- Deliver live snapshots only after successful installation. Subscription and
  initial-snapshot admission share the coordinator's ordering boundary; network
  writes remain outside that lock, using bounded per-client queues.
- Register views through the same coordinator and validated configuration. Preserve
  no-backfill behaviour and persist accepted definitions with SQLite state.
- Migrate Workbench configuration, source publications, expected snapshots and demo
  consumers together. Do not implement reconciliation in the harness or browser.

## Delivery and verification

Continue the current refactor branch and PR; no second work branch or merge is
required. Add coverage of live delivery against the single coordinator, including
retries, failed commits, reconnect snapshots, progress/freshness updates, slow
clients and cancellation. Migrate or replace old-store tests with equivalent
assertions against the retained runtime; retain the strategy and recovery suites.

Run Java verification, Workbench static/build/coverage checks, browser scenarios,
resource checks and the cross-platform CI baseline. Update guides, examples,
source maps and the roadmap to describe one implementation. The migration is
complete only when callers and tests use that implementation and the old runtime
and version-prefixed API have been removed.
