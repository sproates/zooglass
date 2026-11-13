# Memory generation foundation

The private host protocol supports fresh memory runtime generations. The
[document lifecycle executor](timeline-lifecycle.md) now uses this foundation for
v2 stop/start actions, downtime retries and recorded/replayed evidence. SQLite
recovery, runtime snapshot observations and wall adjustments remain planned.

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
separate. Workbench admits public v2 documents through its lifecycle executor and
explicit host capability probe, rather than the host documentFormats list.

## Verification

After explicitly running `npm run prepare:timeline`, run:

```sh
node --import tsx --test test/timeline/generations.test.ts test/timeline/bridge-completion.test.ts
```

The real-host tests check orderly and abrupt replacement, memory identity reset,
receipt wall timestamps, freshness deadlines, same-time restart, global command
budgets and long host pauses. Pipe tests check invalid acknowledgments and process
completion failures. Tests consume the prepared JAR and never build Java.

The document lifecycle suite separately covers generation-qualified tasks and
connections, external retry continuity and v2 evidence. Broader repeated lifecycle
qualification remains separate from these direct process-boundary tests.
