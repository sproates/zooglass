# Bounded automatic source retries

The document executor can own one source publication's receipt deadline and retries.
It uses virtual time, sends the retained bytes to the real runtime, and reconnects
through a fresh generation when a retry executes. It never constructs a successful
receipt or applies the publication itself.

```json
{
  "retries": [
    {
      "action": "send-1",
      "maxAttempts": 3,
      "receiptTimeoutMs": 5,
      "retryIntervalMs": 2
    }
  ]
}
```

`action` names a declared `source-send`. Its actor must have exactly two declared
actions: the initial connect and that send. One policy/publication per managed
source prevents ambiguity with competing manual lifecycle, sends or retries.
Other source/client actors retain their existing controls. Omitted `retries` is an
empty list; null, unknown fields, duplicate owners and non-send targets reject.

`maxAttempts` includes the first send and is 1–10. Timeout and retry interval are
integer virtual milliseconds, each 0–3,600,000. Admission reserves all possible
connection generations: ordinary declared connects plus each policy's
`maxAttempts - 1` must total at most ten. Cancellation consumes no attempt or
connection generation. The ordinary turn/round/queue/trace budgets still apply.

Run the [automatic retry example](../scenarios/simulation/automatic-retry.json):

```sh
npm run timeline:execute -- scenarios/simulation/automatic-retry.json /tmp/automatic-retry.json
npm run timeline:replay -- /tmp/automatic-retry.json /tmp/automatic-retry-replay.json
```

Use the prepared JAR; these commands never build. With its fixed seed, the first
two receipts are lost by closing their source connections. Sends occur at virtual
10, 17 and 24 ms. The third receipt is a real duplicate acknowledgement. Independent
assertions check that the view commits once, expires from the original receipt age,
and never receives a fresh commit merely because of a retry.

## Deadline and cancellation rules

Each actual send arms a phase-one receipt timeout. A nonfinal timeout schedules a
phase-zero retry at `deadline + retryIntervalMs`. On execution, that retry cleans up
any attached old connection, opens a fresh source generation, and schedules the
identical publication as a phase-two input in the next causal round.

A delivered receipt for the current managed action/attempt/generation acknowledges
transport and cancels its pending timeout or queued retry. A rejected publication
receipt also stops retries: acknowledgement does not mean publication acceptance.
Full independent observation assertions still determine the scenario's result.
Receipts for unrelated actions cannot acknowledge the actor. Closed old generations
continue to drop their queued receipts and cannot acknowledge a replacement.

At a zero-timeout tie, timeout phase one precedes receipt delivery phase two. A
nonfinal timeout only schedules a retry; the same-round receipt can cancel it before
it executes, even with a zero retry interval because derived work enters the next
causal round. No extra attempt or connection is consumed. This also holds for a
positive retry interval while the retry is waiting.

The final allowed timeout is terminal immediately, including a tie with receipt
arrival. Therefore timeout zero with maxAttempts one fails; with at least two
attempts a healthy first receipt can cancel the queued retry and pass. Exhaustion
is `assertion-failed`, as is an unacknowledged actor at the horizon, even when
`pendingFutureTasks: allow`. These failures retain completed replayable prefixes.

## Faults and evidence

For a managed send, a receipt-loss rule targeting that action selects its whole
attempt family. Draw keys use the original action ID plus the actual attempt and
connection generation. This is an explicit extension of that selector: an ordinary
unmanaged action still produces only its own send. Every automatic ingress has a
unique `retry-attempt` event, retaining the original action/publication IDs. The
same seed and inputs reproduce the losses and fresh duplicate receipts under replay.

Actor timers use negative task IDs, separate from the Java runtime's positive IDs.
Scheduling, dispatch and cancellation retain causal owners. `retry-lifecycle`
records actual disconnect/connect commands, and `retry-status` distinguishes timeout,
acknowledgement, late receipt and exhaustion. Final pending-task counts include
both model actor timers and real runtime tasks; runtime/agenda equality is checked
separately. An unfinished actor cannot be made successful by shutdown cancellation.

This slice does not add general connection backoff, jitter, multiple in-flight
publications per source, manual control of a managed actor, delayed links, restart,
or automatic retries of failed/rejected business outcomes. These require separate
contracts and evidence.
