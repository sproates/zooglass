# Verification and coverage

The tests give evidence for particular behaviours. Coverage helps locate code
that hasn't been exercised; it doesn't establish that assertions are sufficient,
that every event ordering is correct, or that the service is production ready.

## Reproduce the reports

Use JDK 25 and Node 26, with dependencies installed as described in
[CONTRIBUTING.md](../CONTRIBUTING.md). From `incubator/zooglass`:

```sh
./mvnw --batch-mode clean verify
```

Open `target/site/jacoco/index.html`. XML and CSV reports are alongside it.
`clean` removes old execution data before collecting a local baseline. CI starts
from a fresh checkout and uses `verify`.

From `incubator/workbench`:

```sh
npm ci
npm run test:coverage
npx playwright install chromium
npm run test:browser:coverage
```

On Linux, install Chromium with `--with-deps` if needed. Open
`coverage/standard/index.html` and `coverage/browser-host/index.html`. Each run
replaces its own report; it doesn't erase the other suite's results. Each also
produces `lcov.info` and `coverage-summary.json` for machine inspection.

CI uploads `zooglass-coverage`, `workbench-standard-coverage` and
`workbench-browser-host-coverage` artefacts. Download the archive from the
workflow run and open its HTML entry point locally. Uploads are attempted even
when checks fail, but setup failures or an interrupted test process can leave no
report. A report from a failed run is incomplete evidence.

## Measurement boundaries

- JaCoCo measures production Java code exercised by the Java test suite, including
  its real HTTP and WebSocket tests. It doesn't include the separate service
  processes started by Workbench scenarios.
- c8 measures Workbench `src/**/*.ts` in Node, including inherited Node child
  processes. Source maps attribute execution to TypeScript. Unloaded source files
  remain in the report with zero coverage; tests, dependencies, generated output
  and declaration files aren't counted as production source.
- The browser-host report measures Node orchestration during browser tests. It
  does **not** instrument the vehicle app or Workbench bridge JavaScript executing
  in Chromium. Those have behavioural tests, but no line/branch measurement yet.
- Standard and browser-host reports are separate views of the same Workbench
  source. Don't add or average their percentages. V8 and JaCoCo also count lines
  and branches differently; comparing their percentages as a quality ranking
  would be misleading. In particular, V8's branch denominator depends on which
  functions execute, so even the two Workbench reports have different denominators.
- No coverage threshold is imposed. Examine uncovered paths and the assertions
  protecting them before deciding what to test next.

## Initial baseline

Measured on 25 October 2026 against the production code at `13aba66`, with this
coverage configuration, macOS, Node 26.0.0 and JDK 25.0.5.0.2. These are recorded
observations, not a live badge or a promise that all platforms produce identical
counts. Consult CI artefacts for subsequent revisions.

| Suite and measurement scope | Tests passed | Lines | Branches |
| --- | ---: | ---: | ---: |
| Java service tests / production Java | 11 | 280/345 (81.16%) | 113/167 (67.66%) |
| Standard Workbench tests / Workbench TypeScript | 50 | 1,986/2,901 (68.45%) | 479/591 (81.04%) |
| Browser tests / Workbench TypeScript host | 19 | 76.38% | 69.64% |

The Java live-view request handler covers 9/20 branches (45%), the event input
handler 8/16 (50%), and the broadcaster 19/36 (52.78%). Request validation,
error responses and delivery failure handling need closer attention. The report
links uncovered lines to source; these figures identify investigation targets,
not a claim that every missed branch is a missing requirement.

The standard Workbench suite doesn't execute browser session/demo modules, while
the browser suite does. Conversely, the browser suite doesn't run the integration
CLI. The simple simulator CLI `src/index.ts` remains unexecuted in both reports.
High controller or observer line coverage still doesn't prove all lifecycle
interleavings or rendering states.

## Behaviour-to-test map

Paths below are relative to the repository. The named tests are starting points
for review, not a claim of exhaustive coverage.

| Behaviour | Existing evidence | Remaining gap |
| --- | --- | --- |
| Entity-scoped matching, field replacement and sequence policies | `incubator/zooglass/src/test/java/io/zooglass/ViewStoreTests.java` and `ViewFunctionalTests.java` check selected cases in the store and through real transports. | Seeded permutations and equal-sequence source/field isolation now have direct store checks in `ViewStoreOrderingTests.java`; concurrent transport delivery remains separate work. |
| Scenario execution through the service | `incubator/workbench/test/functional-scenarios.test.ts` executes every JSON scenario through a real service and checks HTTP views and client receipts. | Broader combinations and independent reference-model comparisons. Tests under `test/scenarios/` often validate fixture structure; those checks alone aren't service execution evidence. |
| Subscription, late delivery, duplicates and reconnect snapshots | Java functional tests, Workbench scenario execution and `test/browser/recovery-fixture.test.ts` exercise real connections. | Controlled browser peers now cover update/unsubscribe acknowledgement ordering, stale socket callbacks, both snapshot arrival orders and missing-snapshot cancellation. Automatic retry and real fault-gate recovery remain future work. |
| Per-view freshness and retained data | `test/browser/states.test.ts` controls snapshot arrival and connection failures, including independent latest/history freshness. | Both snapshot arrival orders and old-generation message/open/error/close callbacks are checked in `test/browser/reconnection.test.ts`. Browser behaviour is tested but not instrumented for coverage. |
| Controller and executor lifecycle | `test/demo-controller.test.ts`, `sessions.test.ts`, `browser-client-executor.test.ts` and browser lifecycle tests cover overlap rejection, cancellation, reset, partial setup and cleanup failures. | Reset and close now have a six-boundary matrix in `test/demo-controller-races.test.ts`. This is deterministic sequencing evidence, not exhaustive concurrency exploration. |
| Slow-client protection | `LiveViewBroadcasterTests.java` and `LiveViewIsolationTests.java` use blocked writes to check queue capacity, healthy-peer delivery and writer cancellation; `test/concurrent-clients.test.ts` also pauses a real receiver. | Bounded real transport pressure and concurrent entity streams are checked; extended soak tests and production capacity claims remain outstanding. |
| Invalid inputs and protocol errors | `test/scenario.test.ts`, host validation tests and selected Java validation cases. | The service and browser protocol matrices below cover rejection, continued processing, acknowledgements and timeouts. Broader schema fuzzing, resource limits and permissions remain separate work. |
| Demo rendering | `test/browser/assertions.test.ts`, vehicle/state tests and viewer-controls tests inspect DOM/SVG; deliberately broken rendering fails despite correct receipts. | These verify the demo's representation, not general consumer UIs or visual quality across browsers. |
| Resource and platform behaviour | Session cleanup and repeated browser resets; simulated Windows shutdown outcomes. CI uses Ubuntu and Chromium. | Sustained history/memory measurement, longer repeated lifecycle runs, native platform and additional browser-engine evidence. |

## Generated ordering checks

`ViewStoreOrderingTests` runs 64 fixed seeds. Each shuffles 82 deliveries across
two entities and two matching sources, with exact duplicates, equal-sequence
conflicting payloads, invalid sequences and unmatched source/type combinations.
Every delivery prefix is checked, including changed-view notifications and the
absence of state for an untouched entity. Separate fields isolate each source;
a shared field explicitly exercises their common sequence space.

The independent `OrderingReference` recomputes expected state from the received
prefix using numeric keys and first-arrival values. It doesn't call production
ordering helpers or inspect the store's internal state. Sequences include negative
and fractional values and adjacent integers beyond double precision. A separate
check enumerates all 24 index permutations of three positions and one duplicate;
a focused conflict example makes the first-accepted-payload rule visible.

A failing generated case reports its seed and the first failing prefix. Reproduce
one seed from `incubator/zooglass`:

```sh
./mvnw --batch-mode -Dtest=ViewStoreOrderingTests -Dordering.seed=17 test
```

The seed selects the generated case; the two fixed checks still run. The prefix
removes the irrelevant suffix, but there is no automatic minimal-case shrinker.
These are sequential store tests, not proof of concurrent socket behaviour or
complete coverage of every numeric value and event combination. Existing real
HTTP/WebSocket and Workbench tests continue to cover transport integration.

## Reconnection and lifecycle boundaries

The controlled peer in `test/browser/support/view-peer.ts` supplies real WebSocket
messages and can hold an acknowledgement until a test releases it. The browser
reconnection tests cover:

- Latest-first and history-first snapshots after reconnect, with the other view
  retaining its old value and freshness label until its own snapshot arrives.
- Late message, open, error and close callbacks dispatched explicitly on the old
  real socket. Fresh data must still arrive through the replacement socket.
- A missing snapshot remaining pending until session closure cancels its check.
- An update arriving before unsubscribe acknowledgement, followed by a new
  subscription that requires a fresh snapshot.
- Connection loss while subscribe or unsubscribe acknowledgement is pending:
  reject the operation, fail the run and retain the failed page for inspection.

A separate executor check proves that reconnect clears buffered old receipts and
that a late old-generation observation with a high index cannot suppress a valid
current receipt. These checks don't rely on a sleep to establish event ordering.

`test/demo-controller-races.test.ts` pauses a fake owned run at six explicit
boundaries: source delivery, HTTP check, client receipt check, disconnect,
reconnect and resubscribe. At each boundary, both Reset and Close must cancel the
run, drain the active action, then clean up. Reset can acquire its replacement
only afterwards, and the replacement starts with zero progress and can advance.
Existing tests cover acquisition cancellation and cleanup failure. The matrix
checks controller ownership independently of browser scheduling; existing
real-service/browser reset and recovery tests remain integration evidence.

These are bounded cases, not a claim that every possible interleaving has been
explored. They don't implement automatic retries or a proxy fault gate.

## Concurrent clients and backpressure

`test/concurrent-clients.test.ts` starts real ZooGlass processes and WebSocket
clients. Two source connections deliver 50 updates each to different entities
while another viewer disconnects. Each healthy viewer must receive every update
in its stream and no other entity. The replacement viewer receives the current
snapshot. An unsubscribe check uses a later update on another subscribed entity
as a processing/delivery barrier, rather than a sleep to infer absence.

A second case pauses one receiver after subscription and sends 2,048 updates with
4 KiB of padding each, awaiting the healthy subscriber's receipt after every send.
Compression is disabled so the padding creates actual transport pressure. The
slow receiver must disconnect within the bounded test; the healthy subscriber
continues, and a replacement receives the current snapshot and subsequent update.
HTTP state is checked too. This is about 8 MiB of payload plus protocol overhead,
not a throughput benchmark. It depends on the tested transport/platform buffers;
it does not establish a universal eviction time or byte threshold.

The service requests close status `1013` on queue overflow. A blocked real socket
can instead observe `1006` if the close frame cannot reach it after a write is
cancelled. The network test accepts either outcome; it does not promise delivery
of the close frame. `LiveViewIsolationTests` deterministically checks the server
requesting `1013`, the exact 128-message queue limit while the writer is blocked,
continued healthy delivery, and interruption of writers during removal. These
are complementary forms of evidence, not interchangeable measurements.

The tests close all owned sockets and services even on assertion failure. The
network cases establish bounded-run cleanup and isolation; extended memory and
resource behaviour is still separate work.

## Invalid protocol and partial failure

`test/protocol-validation.test.ts` exercises the real service over HTTP and
WebSocket connections. Its cases distinguish three existing behaviours:

| Boundary | Rejection rule checked | Continuation evidence |
| --- | --- | --- |
| Live-view requests | Malformed JSON, non-object requests, missing/non-text/blank required fields, unknown action and unknown view return an error. | A separate subscriber receives an update after every rejection; the rejected connection can later subscribe, receive snapshots and unsubscribe. Repeated subscribe must not duplicate fanout; repeated unsubscribe remains usable. |
| Source events | Malformed JSON/envelopes, missing/non-text/blank identifiers, non-object payloads and missing/non-numeric sequences do not change the ordered target view. | A valid barrier event follows each invalid message on the same source socket. Its receipt establishes that processing continued before HTTP state is checked. Later valid data changes the target. |
| Runtime view definitions | Invalid fields, matchers and ordering return HTTP 400 without reserving the view ID or registering part of the definition. | A same-source barrier precedes the absence check; a corrected definition with the same ID returns 201, a duplicate returns 409, and later events reach its subscriber. |

`test/browser/protocol-failures.test.ts` supplies malformed JSON, acknowledgements
with the wrong entity/view/action, duplicate acknowledgements and a snapshot
before acknowledgement through the controlled peer. Each must fail the browser
run, refuse further actions and retain the failed page for inspection. A fresh
session then receives a valid snapshot. A separate case withholds acknowledgement
to exercise the actual five-second deadline, then verifies that caller cancellation
closes the retained page. A duplicate acknowledgement may arrive after the first
command completed; that does not make the run successful.

These tests preserve the current contract. Service source validation does not
send error acknowledgements; the browser demo deliberately fails on unexpected
protocol traffic. They do not introduce automatic recovery from malformed data.
Existing `test/sessions.test.ts` cases still cover partial client/source setup,
cleanup continuing when one executor close fails, startup failure and cancellation;
`test/demo-controller.test.ts` checks that failed cleanup prevents replacement.

## Work that follows

First strengthen ordering, recovery and failure tests at service and protocol
boundaries, keeping generated cases reproducible and expected results independent
of production algorithms. Add multi-client and sustained-run evidence, then
review platform scope and harness reliability. Real data-path fault injection,
automatic retry and permissions remain feature work; tests must not imply these
are already implemented.

Use the stronger suite to protect subsequent readability refactoring. Production
and test modules both need clear responsibilities, explicit lifecycle ownership
and manageable complexity. Keep refactors reviewable and preserve behaviour;
coverage percentages alone aren't the acceptance criterion.
