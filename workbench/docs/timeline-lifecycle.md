# Memory stop, restart and downtime retries

`timeline-simulation/v2` runs a bounded memory lifecycle through fresh JVMs. It
keeps the v1 configuration boundary: one source, view and field, receipt-age
freshness and unprotected empty memory storage. Read-only runtime snapshot assertions are also available; wall adjustments
remain unsupported. This is POC functionality;
the earlier 900-run campaigns qualify v1. V2 has a separate bounded
[memory lifecycle qualification](timeline-memory-qualification.md) procedure.

With the host JAR already prepared, run the complete example:

```sh
npm run timeline:execute -- scenarios/simulation/memory-restart.json /tmp/memory-restart.json
npm run timeline:replay -- /tmp/memory-restart.json /tmp/memory-replay.json ../zooglass/simulation-host/target/zooglass-simulation.jar --require-passed
```

The example receives a publication at time 10, loses its receipt, stops at 11,
attempts an unavailable retry at 20 and restarts at 50. The third attempt applies
again to empty memory, producing version 1 and a receipt timestamp of epoch + 50.
Its 30 ms freshness threshold expires at 80. Literal assertions check the complete
frames and receipts, including absence of receipts during downtime.

## Actions and ordering

V2 adds two actorless actions:

```json
[
  { "id": "stop", "atMs": 11, "kind": "service-stop", "mode": "abrupt" },
  { "id": "start", "atMs": 50, "kind": "service-start" }
]
```

`mode` is `orderly` or `abrupt`. Generation 1 starts implicitly at time zero.
Starting an already running runtime or stopping an unavailable runtime is rejected
before execution. At most 16 generations are admitted. Stop/start at the same
timestamp is valid; phase-zero declaration order determines the result before
derived retry timers run.

Each start constructs a new real runtime. Monotonic time starts at zero; wall time
continues at epoch + global time. Orderly stop verifies normal process exit after
runtime shutdown. Abrupt stop kills the JVM between acknowledged turns. Neither
simulates a mid-commit storage crash.

Stop cancels runtime alarms, writer callbacks, held frames and packets in both
link directions. It leaves external source retry timers and attempt budgets
intact. Connection numbers never reset. Only an acknowledged successful open
registers a connection; action/connect records describe the requested operation,
so an infrastructure-failure prefix can end at a connection intent.

## Retry policy

V2 managed retry policies require `unavailableRetryIntervalMs` in addition to the
v1 fields. The example uses:

```json
{
  "action": "send",
  "maxAttempts": 3,
  "receiptTimeoutMs": 10,
  "retryIntervalMs": 0,
  "unavailableRetryIntervalMs": 30
}
```

A sent attempt waits for its receipt timeout, then the normal retry interval.
An unavailable attempt consumes one attempt but sends no bytes, schedules no
receipt timeout and draws no receipt-loss decision. Its next attempt waits the
unavailable interval. An unavailable final attempt fails immediately. Zero-delay
retries advance to the next causal round, with the normal round and attempt bounds.

A standalone failed connect creates no connection and consumes no publication
attempt. A managed initial send ensures a current connection, including when a
stop invalidated its prepared connection. Later managed retries always reconnect.
Unmanaged sends during downtime are recorded as unavailable; after restart they
need an explicit successful reconnect.

The profile conservatively reserves at most ten possible connections from declared
connects plus maximum managed attempts, including attempts that may be unavailable.
This is admission capacity, not an allocation of connection identities. Existing
global command, agenda, message and trace bounds also apply across every restart.

## Evidence and observations

V2 produces `timeline-trace/v2`, `timeline-run/v2` and `timeline-bundle/v2`, with
profile `receipt-age-restart-v1` and bridge protocol 2. Matching versions are
required together. Replay starts with fresh empty memory and re-executes every
stop/start; it never restores recorded outputs as runtime state.

Runtime records identify their actual generation. Runtime tasks are identified by
generation and host-local task number. External retry timer/status records have
null runtime and connection identities; they belong to the source, not a JVM.
Unavailable attempt/connection records also carry null identities and cite the
stop action. Completed trace validation checks generation progression, connection
pairs, task ownership, clocks and causal references before replay starts Java.

Client-frame and source-receipt assertions remain cumulative observations. An
assertion during downtime does not launch a JVM or repair state. After restart,
old observed frames can still be asserted without claiming a connection to the
replacement. Initialization records currently contain an empty snapshots list;
there is no runtime snapshot observation API in this memory slice.

JVM and Node pause diagnostics are retained per generation separately from the
semantic trace. Failed startup, unexpected death, invalid protocol or failed
cleanup remains infrastructure failure with its available trace prefix. It cannot
become a passing scenario or a complete bundle.

SQLite documents now use the same lifecycle ownership with private stores and
read-only recovery assertions. See [SQLite timeline documents](timeline-sqlite.md).
