# Order recovery on the deterministic timeline

Select `runtime.profile: "sqlite-order-restart-v1"` to run the bounded Order
configuration through service stops and fresh JVM generations. ZooGlass performs
SQLite recovery and reconciliation; Workbench owns virtual time, process lifecycle,
controlled links and independently authored assertions.

## Explicit admission

This execution profile requires protocol 2 and the `sqliteOrderLifecycle: 1`
capability, together with SQLite lifecycle and Order support. Configuration
inspection still returns `sqlite-order-v1`: the configuration is unchanged, while
the document explicitly requests lifecycle support. Old hosts cannot silently
execute the new profile. Ordinary `sqlite-order-v1` documents keep their original
single-generation restriction.

Generation 1 starts at virtual time zero with a new private database. Each later
generation opens that same database in a fresh JVM at the declared restart time.
The generation manager retains the artifact, environment and database ownership.
The host requires an existing regular database file for recovery; it cannot prove
a file's lineage across processes on its own. Neither Order profile admits
`wall-clock-set`. Virtual time advances monotonically through downtime.

## Stop, recover and reconnect

Use the existing `service-stop` and `service-start` actions. Orderly stops close the
runtime; abrupt stops terminate the host between completed turns. Abrupt stops do
not model interruption inside a SQLite commit or arbitrary power failure.

Both stops cancel queued traffic belonging to the stopped generation. A progress
request cancelled before arrival cannot commit. A committed request whose reply
is cancelled retains its watermark; an explicit repeat after reconnect receives
its original duplicate acknowledgement. Old traffic is never transferred to the
new generation. Trace validation checks stop-caused cancellation even when an
abrupt stop produces no host connection-close callbacks.

Reconnect actors and resubscribe viewers after restart. Progress sends require a
live connection and running service; documents reject them during downtime.
Source retry behaviour remains governed by the existing lifecycle contract.

Recovery restores selected and nonselected candidates, progress, durable receipt
identities and required-contribution state. Freshness uses the original receipt
time. Reading an installed snapshot must observe the recovered age immediately,
without a later publication or snapshot operation repairing it.

Recovery reclassifies every retained candidate. A changed candidate can cause one
recovery commit for the image, even if only a nonselected backup aged and visible
row versions did not change. Duplicate receipts retain their original versions.
These distinctions matter when authoring literal expectations around a deadline.

## Authored scenarios

The [recovery author](../scenarios/timeline-order-recovery/author.ts) combines fixed
inputs and literal expected receipts, complete snapshots and ordered client frames.
The configuration is byte-identical to the ordinary Order fixture. Four actors
(one multi-source publisher, progress and two viewers) reconnect once, using eight
connection generations. Both viewers subscribe to all four observed view/entity
pairs.

Three documents place restart before, at and after the selected inventory deadline:

| Document                                                   |   Restart | Stop    | Purpose                                                                                                        |
| ---------------------------------------------------------- | --------: | ------- | -------------------------------------------------------------------------------------------------------------- |
| [before](../scenarios/timeline-order-recovery/before.json) | 15,019 ms | Orderly | Nonselected backup ageing advances the global version while visible rows remain unchanged.                     |
| [at](../scenarios/timeline-order-recovery/at.json)         | 15,020 ms | Abrupt  | Inventory is stale exactly at its deadline; selected courier remains fresh.                                    |
| [after](../scenarios/timeline-order-recovery/after.json)   | 15,023 ms | Abrupt  | Recover stale state, reopen a retained gate, preserve an already-open gate and refresh selected contributions. |

The original stop at 48 ms cancels one committed watermark's reply and another
watermark's uncommitted request. The after variant repeats both after reconnect,
checks original duplicate versions and verifies that fresh backup data cannot
replace a stale selected primary. Boundary variants also publish a new event to
expose the otherwise hidden recovery version. Initialization observations are
checked before any subsequent input can alter recovered state.

From `workbench/`, with the host already prepared:

```sh
npm run timeline:execute -- scenarios/timeline-order-recovery/after.json /tmp/order-recovery.json
npm run timeline:bundle -- record scenarios/timeline-order-recovery/after.json /tmp/order-recovery-bundle
npm run timeline:bundle -- replay /tmp/order-recovery-bundle /tmp/order-recovery-replay.json --require-passed
```

Regenerate documents only after reviewing their authored inputs and expectations:

```sh
node --import tsx scenarios/timeline-order-recovery/author.ts
```

## Scope

The [ordinary two-cycle scenario](timeline-order-scenario.md) remains a separate
input-preservation test. Recovery checks use smaller ready and gated entities to
make retained contributions, duplicate identities, source priority and deadline
boundaries explicit. They do not replace the identity-window retention work or
repeatability and ordinary-service parity qualification.

All execution and replay consume a prepared simulation host. No timeline test or
run command builds Java. Protected transport, browser behaviour, wall-clock
rollback, mid-commit crashes and cross-platform determinism are outside this slice.
