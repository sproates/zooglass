# Static-view recovery

Implementation candidate: `static-views-restart-v1` combines the existing static
arrival/latest/history family with memory or SQLite, orderly or abrupt stops
between completed turns, and explicit reconnects and exact retries. The separate
finite qualification in the [accepted design](../../docs/design/timeline-static-recovery.md)
has not yet been run. Focused tests are not a substitute for that qualification.

## Author and run

Start with one of the [six authored examples](../scenarios/timeline-static-recovery/README.md).
Use ordinary runtime JSON; expand configuration templates first. Set the scenario
format to `timeline-simulation/v4`, select `static-views-restart-v1` explicitly,
and keep its storage equal to the exact hashed configuration file. Do not relabel
a converted V3 bundle: V4 does not admit conversion provenance.

Prepare the host explicitly using the [standard setup](timeline-guide.md#prepare-and-run).
Commands and tests never build Java. From `workbench/`:

```sh
npm run timeline:inspect -- admission scenarios/timeline-static-recovery/s1/scenario.json ../zooglass/simulation-host/target/zooglass-simulation.jar
npm run timeline:bundle -- record scenarios/timeline-static-recovery/s1/scenario.json /tmp/new-recovery-bundle
npm run timeline:bundle -- replay /tmp/new-recovery-bundle /tmp/new-recovery-report.json
```

Both storage modes use fresh JVM generations. Memory restarts empty; SQLite reuses
only the current run's private store and restores durable state. Replay starts
with a new empty store and re-executes all publications. Old stores are not replay
inputs. Configuration and runtime identities remain fixed across generations.

Declare source reconnect and viewer reconnect/resubscribe after each restart.
`source-retry` refers to the original publication, previously sent by the same actor.
Use full `source-receipts` assertions to distinguish memory reapplication from
SQLite duplication and retained original receipt versions. `source-accepted` is
only a broad acceptance check for a sole `source-send` at its actor's timestamp;
a simultaneous retry makes that projection ambiguous and is rejected.

Check `runtime-snapshot` immediately after restart, before any new publication.
Full observations can assert runtime unavailability during downtime. `runtime-data`
requires an available runtime and compares a complete non-null public data object.
Actor actions during downtime are rejected. The same-time phase/declaration order
is unchanged: connect/disconnect and lifecycle controls share phase zero; source
and subscription actions follow in phase two.

## Limits and evidence

The original static shape and capacity limits remain: up to three sources, two
views, four fields total and three per view. Only same-source aliases,
envelope entity mapping, partial publication, unspecified freshness, untracked
progress and acceptance of late inputs are admitted. Links have zero latency.
No automatic retry, fault rule, writer stall, clock adjustment, fact/progress
control, dynamic view definition or configuration mutation is included.

V4 run, trace and bundle identities remain distinct from V1–V3. Existing evidence
retains its original artifact/environment requirements. Standalone trace checks
validate the recovery action boundary; bundle replay also binds actions and
assertions to the exact scenario and re-executes the production runtime.

The six examples and focused tests demonstrate implementation behaviour. The
planned baseline/paused trace comparison, wrong-recovery control and ordinary-service
comparisons remain a separate qualification milestone. No cross-platform,
arbitrary mid-commit crash or new performance guarantee is claimed.
