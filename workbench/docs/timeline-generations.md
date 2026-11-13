# Memory generation foundation

The private host protocol now supports fresh memory runtime generations. This is
an implementation foundation, exercised directly by prepared-host tests. The
document CLI still accepts only `timeline-simulation/v1`; stop/start documents,
downtime retries, generation-aware agenda cancellation and v2 replay evidence
are not implemented yet. SQLite recovery and wall adjustments remain planned.

## Clock and process ownership

`RuntimeGenerations` owns one active JVM and an immutable handle for its generation.
Generation 1 starts at global time zero; each later start launches a fresh JVM.
For global time `T`, generation start `S` and fixed epoch `E`, the runtime reads
monotonic time `T − S` and wall time `E + T`. Alarms remain scheduled at global
`T + delay`. Clocks are installed before constructing the production runtime.
No elapsed process startup or shutdown time contributes to these values.

Commands require the active generation handle. A handle from an earlier generation
cannot dispatch a callback into a replacement, even when both hosts allocate the
same task number. The owner keeps command IDs and a bounded command budget across
starts, caps generations at 16 and rejects backwards global time. Artifact and
JVM environment identity must remain the same across generations.

Orderly stop acknowledges the runtime's `shutdown` turn, closes stdin and verifies
normal process exit. Abrupt stop kills the process after an acknowledged turn and
verifies the expected termination. Neither permits an unexpected process failure
to become a successful modelled stop. Failed execution is terminal; force cleanup
does not count as a simulated stop or permit restarting the failed run.

## Private protocol admission

Protocol 1 is unchanged. Selecting protocol 2 requires the host handshake capability
`memoryLifecycle:1`; its `documentFormats` is empty. The first command is
`initialize-document`, carrying configuration, epoch and generation start, with
explicit generation, global turn ID and all three clock coordinates. Subsequent
command IDs are consecutive. Every response echoes the generation and clocks.
Protocol 2 does not offer configuration inspection; existing v1 preflight remains
separate. No public v2 document support can be inferred from the private protocol.

## Verification

After explicitly running `npm run prepare:timeline`, run:

```sh
node --import tsx --test test/timeline/generations.test.ts test/timeline/bridge-completion.test.ts
```

The real-host tests check orderly and abrupt replacement, memory identity reset,
receipt wall timestamps, freshness deadlines, same-time restart, global command
budgets and long host pauses. Pipe tests check invalid acknowledgments and process
completion failures. Tests consume the prepared JAR and never build Java.

These tests do not establish document-level restart determinism. The next step
integrates generation-qualified tasks and connections with the global agenda and
external retry timers, then qualifies recorded/replayed lifecycle scenarios.
