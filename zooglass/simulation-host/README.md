# Controlled simulation host

This separate Java executable lets Workbench drive real ZooGlass reconciliation,
freshness and delivery under a virtual-time agenda. It supports the fixed proofs
and the bounded `memory-arrival-v1` document profile. It does not start Spring or
open a socket listener. A private protocol 2 additionally supports the
[memory generation foundation](../../workbench/docs/timeline-generations.md).
Document stop/start actions, SQLite restart and protected access remain planned.

## Prepare and run

Use JDK 25 and Node 26. From `../../workbench/`:

```sh
npm run prepare:timeline
npm run timeline:execute -- scenarios/simulation/warehouse-retry.json /tmp/warehouse-run.json
npm run test:timeline
```

Preparation explicitly installs the production project, packages this project and
checks the resulting artifacts. Tests and execution never invoke Maven or prepare
a missing JAR. Reprepare after changing either project or its dependencies.
The host artifact is `target/zooglass-simulation.jar`; Workbench launches it with
`java -jar` and exchanges bounded framed commands over stdin/stdout. Diagnostics
use stderr. Before launch, Workbench validates the manifest in the bounded,
single-disk ZIP32 layout produced by preparation and rejects a service JAR or
another entry point. Use a host you trust: the manifest check identifies the
entry point without authenticating its code. The fixed `JarLauncher` entry point
ignores ambient Spring Boot loader configuration. Host time does not advance
simulation time.

The host's Java tests can be run from `../` with
`./mvnw --batch-mode -f simulation-host/pom.xml surefire:test` after preparation
has compiled them. The Workbench timeline suite exercises the prepared executable.

## Artifact and source ownership

The production project supplies an ordinary `runtime` classifier dependency.
Its service JAR remains `../target/zooglass.jar`; both production artifacts exclude
simulation classes, including stale compiled output. This project packages its own
adapters and the matching runtime dependency once. Preparation checks the embedded
runtime hash against the freshly built classifier and fails preparation on a
mismatch. Installing a stale local snapshot cannot silently pass this check; the
packaging regression also verifies rejection of a mismatched runtime artifact.

Host adapters retain the runtime and delivery Java packages so they can use small
package-private seams in the same application classloader. There is no module-path
split, copied reconciliation implementation or public simulation extension API.
The production project has no dependency on this host.

- `simulation/HostProtocol` owns framing, strict command fields and JSON handling.
- `simulation/HostTurns` admits consecutive command identities for one generation.
- `simulation/RuntimeGeneration` owns generation identity and global/local clock
  conversion before runtime construction.
- `simulation/TimelineHost` composes one runtime and its sessions; `TurnContext`
  owns controlled tasks and active-turn checks.
- `runtime/TimelineRuntime` and `TimelineProfile` construct and qualify the bounded
  runtime. `ControlledReceiptClock` and `ControlledAlarmScheduler` supply its clocks
  and deferred alarms.
- `delivery/TimelineDelivery` drives the real writer and queue through controlled
  callbacks. `HostTimingProbe` adds host-only pause diagnostics for qualification.

Each controlled writer owns its stall state, held handoff and deferred callbacks.
Stopping it releases those resources and removes its registry entry; reusing a
session name cannot inherit them. Deferred closes refer to the original connection.
`TurnContext` checks ownership and dispatch time before changing clocks or tasks,
so rejected operations do not corrupt the next valid turn. Both pipe endpoints
reject malformed UTF-8 rather than silently replacing payload characters.

## Refactor validation

The 13 November 2026 refactor passed 90 timeline tests, 144 Workbench core tests,
two packaging checks and four host Java tests. Across the three published document
scenarios, all 228 semantic event records remained byte-identical to the previous
implementation. Artifact, module and dependency-lock identities changed as expected;
this comparison does not claim exact replay across those changed identities.
The evidence covers the existing memory profile, not future restart support.

See the [Java source map](../docs/source-map.md#controlled-timeline-proof-host),
[Workbench execution guide](../../workbench/docs/timeline-execution.md) and
[restart design](../../docs/design/timeline-restart-boundary.md).
