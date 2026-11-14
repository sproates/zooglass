# Controlled wall-clock adjustments

V2 documents can declare an actorless action with `id`, `atMs`,
`kind: "wall-clock-set"` and absolute `wallMillis`. The wall value is a
nonnegative safe integer. V1 does not admit this action.

For global time T, generation start S, epoch E and current wall offset A:

- Runtime wall time is E + T + A.
- Runtime monotonic time remains T − S.
- Alarms, transport deadlines and source retries remain in global T.

A wall action sets A to `wallMillis − E − T`. It runs in phase zero, in declared
order relative to same-time stop/start actions. During downtime it makes no IPC
call; the next initialization installs that offset before production recovery.
A setting before startup affects recovery. A setting after startup cannot change
what recovery already installed.

While running, the dedicated host command changes only the controlled clock.
It cannot expire a view, commit SQLite, schedule a task or deliver a frame.
Ordinary host commands cannot alter the offset. Native capability
`wallClockAdjustments:1` is required before any run storage is allocated.

The [SQLite rollback example](../scenarios/simulation/sqlite-wall-rollback.json)
shows unknown age after restart, an unchanged duplicate, a new contribution
repairing freshness, and its later monotonic expiry. With a prepared host, from
`workbench/`:

```sh
npm run timeline:bundle -- record scenarios/simulation/sqlite-wall-rollback.json /tmp/wall-bundle
npm run timeline:bundle -- replay /tmp/wall-bundle /tmp/wall-replay.json --require-passed
```

## What production decides

A forward wall jump does not shorten live receipt-age expiry: elapsed age uses
monotonic time. Backwards wall time does not itself manufacture persisted
uncertainty. Production records rollback when it commits an affected clock sample.
Duplicate-only traffic may return without such a commit.

Recovery compares its current wall time with the durable high-water mark and
uncertainty flags. It may expose `ageUnknown` with a null receipt timestamp.
A duplicate preserves the original durable receipt and cannot repair unknown age.
A new accepted contribution can restore freshness using its new receipt time.
The simulator neither resets the durable high-water mark nor computes substitute
recovery results.

## Bounds and evidence

The existing epoch-plus-horizon safe-integer bound remains in force. Each adjusted
wall segment must remain in range through the next setting or end of the document,
including the endpoint. This intentionally conservative admission rejects a
schedule that would depend on replacing an already out-of-range wall sample.
Virtual/global time never moves backwards.

The action's absolute wall value appears in the semantic trace. Initialization
records the adjusted wall time and monotonic zero. Replay binds runtime-control
order, IDs, times and values to the retained scenario, rather than accepting a
self-consistent altered offset. Exact replay still requires matching executable,
module and environment identities.

The literal tests cover forward jumps, downtime rollback, duplicate-only live
rollback, a new commit persisting uncertainty after wall time catches up,
new-input repair and same-time startup ordering. Paused execution and replay
check selected cases. These are implementation checks; the broader repeated
[SQLite restart campaign](timeline-sqlite-qualification.md) and deliberate
[recovery-clock control](timeline-recovery-clock-control.md) remain separate.
