# Fixed-fixture deterministic timeline proof

This POC exercises real ZooGlass handlers, reconciliation, freshness, subscriptions
and bounded writer queues under a Workbench-owned agenda. It supports two literal
memory/unprotected scenarios. It is not the general simulator or a replacement for
`simulate` or real-socket integration tests.

For configurable versioned scenarios, see the separate [document executor](timeline-execution.md).

From `workbench/`, prepare the artifact explicitly:

```sh
npm run prepare:timeline
npm run test:timeline
npm run timeline:proof -- receipt /tmp/receipt-proof.json
npm run timeline:proof -- delivery /tmp/delivery-proof.json
npm run timeline:repeat -- ../../artifacts/timeline-proof
```

Execution and tests require an existing `zooglass/target/zooglass.jar`; they never
build Java. The executable uses Spring Boot's properties launcher with the explicit
`io.zooglass.simulation.TimelineHost` main class. No server or socket listener starts.
The private pipe protocol uses bounded length-prefixed JSON and turn identities.
Diagnostics go to stderr. Host watchdogs report infrastructure failures.

## What the fixtures check

- **Receipt loss and freshness:** a keyed SHA-256 decision closes the source
  connection after its first commit, preventing receipt arrival. A timeout retries
  identical publication bytes through a fresh connection. The real duplicate
  receipt retains version and receipt age. The all-zero 256-bit seed loses the
  receipt; the seed consisting of 64 `2` digits does not.
- **Virtual time:** a host pause exceeds the 100 ms freshness threshold while
  virtual time is frozen. Deadline minus one stays fresh. At the deadline, the
  alarm expires state before a same-time publication; both versions reach clients.
  An hour-long virtual jump runs without an hour-long host wait. Observations never
  read snapshots or repair missing alarms.
- **Stalled delivery:** one acknowledgement remains in flight while real queued
  updates coalesce. The healthy subscriber continues; same-time inputs also
  coalesce there because writer turns follow the input burst. Releasing the held
  handoff delivers the protected baseline before the newest queued update.
- **Exact data:** a large integer, a precise decimal, negative zero and shuffled
  object keys pass through the actual publication parser. Wire strings cross Node
  losslessly; the transcript includes canonical exact-decimal JSON, not rounded
  JavaScript payload numbers. Independent fixture expectations check every state
  transition, complete receipt (including targets), baseline and delivered frame.
  Client payloads, provenance, publication identities and freshness are checked
  directly; client expectations are not generated from runtime state snapshots.
- **Replay:** each repetition starts a new Node/JVM pair. Both fixtures execute
  100 times with bridge delays of 0–2 ms and fast/paced presentation. Actual effects
  must match. Manifests identify the Java JAR and proof modules. Altering a saved
  expected effect stops a fresh verification run at the first divergent turn,
  before later actions execute. Completed runs can also be compared offline.

The agenda orders `(time, round, phase, ordinal)`. Same-time derived work enters the
next round. Lifecycle/link changes use phase zero; deadlines and writer tasks use
phase one; inputs and transport completions/arrivals use phase two. A timeout
defers reconnection to the next round, and releasing a stalled link defers its
handoff completion. Explicit bounds cover time, rounds, turns, tasks, trace bytes,
frames and fixture connections. The fixtures end with no outstanding work or held
frames. Shutdown is an explicit later phase-zero turn and its effects are recorded.
The bridge rejects overlapping commands before sending or allocating a turn ID.
Unknown command fields are rejected, including unsupported storage/access requests.

## Negative controls and limits

`no-alarms` can be passed as the last CLI argument to disable dispatch in the proof
adapter. The receipt fixture must fail `deadline expiry must originate from alarm`;
input-side expiry cannot rescue it. The focused tests require this failure.
Only alarm-tagged tasks are suppressed; writer tasks still run. Other negative
checks corrupt delivered data and receipt targets to verify the literal oracle.

A separate prepared mutation artifact changes expiry to retain a fresh age. The
same fixture must execute against that artifact's own valid manifest and fail
`deadline must expire before same-time input`. An artifact mismatch or startup
failure does not count as a successful mutation check. Mutation preparation is a
separate explicit build, never part of execution or test startup:

```sh
python3 scripts/prepare-timeline-mutation.py /tmp/zooglass-timeline-mutant
node --import tsx scripts/timeline-mutation-check.ts /tmp/zooglass-timeline-mutant/zooglass/target/zooglass.jar
```

The mutation check runs against its own artifact identity twice, requires the named
behavioural failure, and compares the newly executed wrong trace prefixes. Failed
CLI runs also save their executed prefix with an assertion/infrastructure outcome.

The fixed syntax is private to this proof. General scenario validation, full fault
rules, SQLite/restart, protected access, browser work, UI, campaigns and complete
production concurrency modelling remain unimplemented. Native/control writer
parity and protected transport regressions remain covered by the Java delivery
suite; this proof does not replace those tests. Passing these fixtures provides
evidence for this bounded architecture, not a guarantee for unimplemented paths.

The separate [experimental format inspector](timeline-format.md) now validates
versioned documents and structural traces and audits legacy compatibility. It does
not extend this fixed runner's executable scope or replace its private transcript.
