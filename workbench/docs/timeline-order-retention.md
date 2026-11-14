# Order identity retention on the timeline

The Order configuration retains publication identities within a 128-sequence
window for each source/epoch/entity stream. This is a sequence range, not a queue
of the last 128 arrivals. The deterministic fixture keeps the real SQLite
configuration and checks the boundary through production receipt and progress
interfaces.

## What the window means

An accepted publication can advance its stream's lower boundary to
`publicationSequence - 128 + 1`. Arrivals below that boundary are rejected with
`outsideRetention`, even if their payload matches an earlier publication. A
retained exact duplicate returns its original durable version and target results;
a retained identity with different content is rejected with `identityConflict`.
Rejected receipts report the current global version and do not create a commit.

A missing publication below the boundary becomes an `expired` progress gap. It
cannot be repaired by resending that identity. Missing identities still within
the window can remain provisional or be confirmed by a watermark. Advancing a
watermark does not move the identity window. A later accepted publication at or
below that watermark records a source-contract violation; a duplicate does not
become a new publication.

These distinctions survive SQLite recovery. Restart does not reset the window,
restore forgotten receipts, refresh receipt age or discard the latest watermark's
original acknowledgement version. The fixture uses the explicit
[Order lifecycle profile](timeline-order-recovery.md), with independently authored
expectations rather than runtime-generated answers.

## Authored boundary case

The fixture publishes sequences 1, 3, 128 and 130 on `orders/run/order-1`.
Sequence 1 is still retained at 128. At 130 the lower boundary is 3: identity 1
is rejected, identity 3 remains retained, and missing sequence 2 is expired.
Both exact and conflicting old content are rejected as outside retention; only
retained identities can produce an identity conflict.

Watermark 1 keeps its original acknowledgement version after the floor moves.
Advancing to watermark 128 confirms missing sequences within the retained window
without changing the floor or turning the expired gap into a confirmed one.
The expired gap remains visible and completeness stays incomplete; forgetting an
identity does not establish that its missing publication was received.
A short restart preserves these outcomes. New late sequence 129 repairs its
provisional gap without replacing selected sequence 130; new sequence 4 is below
the watermark and records the contract violation. Repeating a retained identity
alone does not set that flag.

Only the order contribution is populated. The summary exposes it, while tracking
remains behind its required-inventory gate. No freshness-bearing contribution is
present, so recovery adds no ageing commit. Freshness and reopened gates are
covered by the separate recovery fixtures.

## Run and maintain the fixture

From `workbench/`, with the simulation host already prepared:

```sh
npm run timeline:execute -- scenarios/timeline-order-retention/scenario.json /tmp/order-retention.json
npm run timeline:bundle -- record scenarios/timeline-order-retention/scenario.json /tmp/order-retention-bundle
npm run timeline:bundle -- replay /tmp/order-retention-bundle /tmp/order-retention-replay.json --require-passed
```

Use new output paths where required. Every execution and replay starts with its
own new database, then reopens that database at the declared restart. The
[author](../scenarios/timeline-order-retention/author.ts) serializes fixed inputs
and independently declared observations. After reviewing any change, regenerate
its checked-in document with:

```sh
node --import tsx scenarios/timeline-order-retention/author.ts
```

## Scope

This is a bounded identity/progress boundary case. The [ordinary Order scenario](timeline-order-scenario.md)
preserves the completed demo's six-order, two-cycle input schedule; the
[recovery scenarios](timeline-order-recovery.md) separately check freshness and
retained required contributions. These fixtures have different purposes.

This case crosses the numeric sequence window using sparse inputs. It does not
fill 128 receipt entries, reproduce the ordinary demo's 50-cycle run or establish a
memory/storage growth bound. Repeated fresh-process qualification, deliberate
wrong-runtime controls and ordinary-service parity remain separate work. Tests
and replay consume an already prepared host and never build Java.
