# Fleet qualification

This qualification checks the [authored fleet scenario](timeline-fleet-scenario.md)
through three complementary paths: controlled repeatability, a deliberately wrong
production strategy, and ordinary-service WebSocket/HTTP behaviour. It uses one
fixture group on the recorded native environment. It is not a cross-platform,
physical crash or full Workbench compatibility claim.

## Controlled repeatability

From `workbench/`, with the simulation host already prepared:

```sh
npm run timeline:fleet-repeat -- NEW_SMOKE_DIRECTORY ../zooglass/simulation-host/target/zooglass-simulation.jar 2
npm run timeline:fleet-repeat -- NEW_QUALIFICATION_DIRECTORY ../zooglass/simulation-host/target/zooglass-simulation.jar 20
```

A full campaign requires a clean committed checkout. It runs one unperturbed
baseline and 19 fresh-process repetitions, alternating Node/JVM requests of
70/90 ms with pacing and 90/70 ms without pacing. Three workers bound resource
use. Two runs are only a smoke check. Seeds do not multiply this single fixture
into nominally different behaviours.

Each run must satisfy all 62 independent assertions, 16 complete receipts and
28 client frames, and reproduce the complete 432-record trace. The checker also
requires measured JVM pauses at the first writer handoff (time 0) and state effect
(time 60), and Node delays during real commands including late input at 240.
Node measurements must exceed 50 ms and JVM measurements meet the requested
length. This sequence profile has unspecified freshness; these are host-timing
perturbations, not receipt-age expiry evidence.

The shared runner retains exact canonical inputs, configuration bytes, commands,
source/tool/artifact/environment identities, raw runs and hashes. Failed or
incomplete matrices cannot qualify. Actual command execution and tests never
build Java.

## Wrong-strategy control

The [strategy control](timeline-fleet-strategy-control.md) changes the actual
production latest-by-sequence strategy to unconditional replacement in an isolated
prepared artifact. The valid fleet configuration and authored assertions remain
unchanged. Normal execution must pass; both ordinary and paused mutants must
reach and fail `frames-240`, with the same wrong trace. Admission rejection or
infrastructure failure is not a successful negative control.

## Ordinary-service parity

Use the already prepared service directory, containing `target/zooglass.jar` and
its matching `target/zooglass-runtime.jar`:

```sh
npm run timeline:fleet-service-parity -- NEW_DIRECTORY ../zooglass qualification
```

The script starts and owns one ordinary service with the exact bounded fleet
configuration. Real source sockets send the same 16 publications and the client
subscribes to all six targets. Receipts, complete HTTP snapshots and observed
client state are checked against the independently authored expectations.
Receipt and state barriers establish progress; elapsed sleeps do not establish
correctness. Unsubscribe acknowledgements provide final per-subscription barriers.

The evidence retains sent/received wire messages, HTTP observations, configuration,
artifact/core-class identities, source hashes and before/after provenance. Service
startup and shutdown use the shared owned-session lifecycle. No Java build is
invoked. The service's larger default configuration is not substituted for the
bounded one: identity-window metadata must agree with the controlled run.

Real socket arrival timing and cross-subscription frame ordering are not required
to match a deterministic trace. The controlled same-time two-source/two-client
ordering case was separately verified by the host foundation tests at `de8f628`;
the repeated fleet fixture here has distinct publication timestamps. Those are
complementary claims, not additional campaign groups.

## Retention

Publish final raw campaign, control and parity evidence as a GitHub Release asset;
retain hashes and provenance in the [evidence manifest](../evidence/README.md).
Archives contain no executable artifacts or databases. Re-execution still requires
the matching prepared artifacts and environment; archive verification checks bytes
and inventory only.

## Recorded result

Workbench commit `1724c4ca9b0ed6f3343223d4d9c37bfaa2a3074c` passed the
qualification on native macOS arm64. All 20 fresh Node/JVM runs passed 62 literal
assertions each (1,240 total) and reproduced the same 432-record trace. Evidence
contains 3,078 measured Node delays and 38 JVM pauses. This is one fixture group,
not 20 distinct scenarios.

The isolated normal strategy passed. Both wrong-strategy executions failed
`frames-240` with identical 328-record traces, selecting late position 41 at
version 9 instead of retaining position 42 at version 7. Artifact inspection
confirmed that only `LatestBySequence.class` changed inside the production runtime.
The hosts were prepared from Java source at `fa7284c`; its Java tree is identical
to the tested tooling commit, and both revisions are recorded.

Ordinary-service parity verified 16 complete receipts, 122 HTTP observations,
20 legacy checkpoints, 28 authored client frames and six final unsubscribe
acknowledgements. All 204 production classes matched the prepared runtime embedded
in the simulation host. Strict replay independently re-executed and verified all
432 records with a passed outcome. Independent raw-evidence review found no
remaining issues.

One campaign-checker test, seven strategy/clock-control tests and six service-session
tests passed, together with focused type, lint and formatting checks. The
[evidence manifest](../evidence/README.md) pins the raw runs, preparation provenance,
independent audit script/report and validation logs. Qualification does not extend
to Order/Sports, fleet SQLite/restart combinations, other operating systems or
arbitrary socket ordering.
