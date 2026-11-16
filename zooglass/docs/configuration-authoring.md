# Adopt local configuration templates

Use templates when several fields share the same input and policy settings.
Keep ordinary runtime JSON when it is already clear. Templates reduce repeated
settings; they do not remove the need to choose storage, source epochs, capacity
limits or update modes.

The [authored sales file](examples/configuration/sales.authored.json) maintains its
source/type and three fact settings once for two projections. It is 463 compact
JSON bytes versus 522 for the [ordinary sales file](examples/configuration/sales-sqlite.json),
a modest 11% reduction. The main benefit is one-place maintenance. The orders
example remains ordinary JSON because it has no equivalent repeated group.

## Check, expand, review, run

Use JDK 25 and a [prepared production JAR](../README.md#run-locally). The commands
below run from the repository root and never build Java automatically.

1. Check authored input and read the effective policies, defaults and template origins:

   ```sh
   java -jar zooglass/target/zooglass.jar config check zooglass/docs/examples/configuration/sales.authored.json
   java -jar zooglass/target/zooglass.jar config explain zooglass/docs/examples/configuration/sales.authored.json
   ```

2. Expand to a **new destination**. Choose a different output filename for each
   revision; existing files cannot be overwritten:

   ```sh
   mkdir -p /tmp/zooglass-authoring
   java -jar zooglass/target/zooglass.jar config expand zooglass/docs/examples/configuration/sales.authored.json --output /tmp/zooglass-authoring/sales.runtime.json --json
   ```

   Require exit 0 before using the output. The report identifies the exact source,
   output and prepared JAR with SHA-256 hashes. Keep the authored file, expanded
   file and report together if you need to reproduce a deployment. Hashes identify
   bytes; they are not signatures or proof of deployment safety.

3. Review the ordinary runtime JSON. Check that shared template changes affect only
   the intended fields and that each use still declares the correct mode/property.
   Inspect it independently when useful:

   ```sh
   java -jar zooglass/target/zooglass.jar config explain /tmp/zooglass-authoring/sales.runtime.json
   ```

4. Pass that file explicitly to the service. For a fresh sales demonstration:

   ```sh
   mkdir -p /tmp/zooglass-authoring/sales-store
   java -jar zooglass/target/zooglass.jar \
     --server.address=127.0.0.1 --server.port=8080 \
     --zooglass.config=file:/tmp/zooglass-authoring/sales.runtime.json \
     --zooglass.database=/tmp/zooglass-authoring/sales-store/state.sqlite
   ```

   The database directory must be fresh for a new demonstration. After the service
   is healthy, run `node zooglass/docs/examples/configuration/run-example.mjs sales`
   from another terminal. Follow the [sales restart procedure](configuration.md#sales-with-sqlite-recovery)
   using this same service command and database. This is an open-access loopback
   demonstration; application deployment still needs [protected access](protected-deployment.md).

Ordinary runtime JSON remains supported directly. No template conversion or new
command is required for existing configurations. The service never expands authored
input implicitly. Workbench likewise consumes the expanded file and retains its
own profile admission, artifact identity and replay checks; successful configuration
checking does not widen deterministic-timeline support.

## Changing an existing deployment

An authored file is a source file, not a running configuration. Edit it, check it,
expand to a new path, and review the result before changing the deployed file.
Do not overwrite a file that a running or restarting process may read.

A valid configuration is not necessarily compatible with a stored SQLite database.
For example, changing the sales template's `maxRetainedFacts` from 100 to 101
changes both projection definitions. The new file passes configuration checking
but the existing store rejects it at startup. Expansion performs no migration.
Keep the original expanded file available and follow the existing runtime recovery
contract. Delivery settings are process-local; they are still included in full
configuration comparisons even though SQLite does not persist them as view definitions.

[Command contracts and limits](configuration-inspection.md) explain the strict
local grammar, 16 MiB bounds, diagnostics, cleanup limits and script exit codes.
No includes, inheritance, overrides, expressions or environment substitution are
available. If two fields need different policies, declare that difference explicitly.

## Verification and limits

The automated qualification uses the actual prepared service JAR. It verifies:

- Full production-decoded equality between authored sales, expanded output and the
  original runtime file, including all root capacities and delivery settings.
- An explicit-default equivalent with the same effective settings but different
  declaration provenance, and valid changed bounds that remain detectably different.
- Creation, correction and withdrawal through real interfaces, followed by SQLite
  restart with the same full snapshot/version and duplicate-receipt identity.
- Rejection of the runtime-valid changed template against that store, followed by
  successful recovery with the original file on the same database and unchanged result.
- Continued use of the ordinary orders and sales examples without templates.

The grammar/output tests separately cover exact integers and semantic array order,
repeatable bytes, independent hashes, invalid references, limits and output ownership.
See the [verification map](../../docs/testing.md#offline-configuration-inspection).
These are finite behavioural checks, not a general migration guarantee, performance
claim or qualification of every possible configuration. They do not require a new
runtime format or any additional authoring feature.
