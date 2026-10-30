# Verification and coverage

The tests give evidence for particular behaviours. Coverage helps locate code
that hasn't been exercised; it doesn't establish that assertions are sufficient,
that every event ordering is correct, or that the service is production ready.

## Reproduce the reports

Use JDK 25 and Node 26, with dependencies installed as described in
[CONTRIBUTING.md](../CONTRIBUTING.md). From `zooglass`:

```sh
./mvnw --batch-mode clean verify
```

Open `target/site/jacoco/index.html`. XML and CSV reports are alongside it.
`clean` removes old execution data before collecting a local baseline. CI starts
from a fresh checkout and uses `verify`.

From `workbench`:

```sh
npm ci
npm run prepare:service
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
| Entity-scoped matching, field replacement and sequence policies | `zooglass/src/test/java/io/zooglass/ViewStoreTests.java` and `ViewFunctionalTests.java` check selected cases in the store and through real transports. | Seeded permutations and equal-sequence source/field isolation have direct store checks in `ViewStoreOrderingTests.java`; concurrent transport cases are described below. Arbitrary orderings remain unproven. |
| Scenario execution through the service | `workbench/test/functional-scenarios.test.ts` executes every JSON scenario through a real service and checks HTTP views and client receipts. | Broader combinations and independent reference-model comparisons. Tests under `test/scenarios/` often validate fixture structure; those checks alone aren't service execution evidence. |
| Subscription, late delivery, duplicates and reconnect snapshots | Java functional tests, Workbench scenario execution and `test/browser/recovery-fixture.test.ts` exercise real connections. | Controlled browser peers now cover update/unsubscribe acknowledgement ordering, stale socket callbacks, both snapshot arrival orders and missing-snapshot cancellation. `test/browser/connection-loss.test.ts` checks automatic recovery against real ZooGlass, including source continuity and first snapshots. |
| Per-view freshness and retained data | `test/browser/states.test.ts` controls snapshot arrival and connection failures, including independent latest/history freshness. | Both snapshot arrival orders and old-generation message/open/error/close callbacks are checked in `test/browser/reconnection.test.ts`. Browser behaviour is tested but not instrumented for coverage. |
| Controller and executor lifecycle | `test/controller-*.test.ts`, `scenario-session.test.ts`, `zooglass-session.test.ts`, `browser-client-executor.test.ts` and browser lifecycle tests cover overlap rejection, cancellation, reset, partial setup and cleanup failures. | Reset and close now have a six-boundary matrix in `test/demo-controller-races.test.ts`. This is deterministic sequencing evidence, not exhaustive concurrency exploration. |
| Slow-client protection | `LiveViewBroadcasterTests.java` and `LiveViewIsolationTests.java` use blocked writes to check queue capacity, healthy-peer delivery and writer cancellation; `test/concurrent-clients.test.ts` also pauses a real receiver. | Bounded real transport pressure and concurrent entity streams are checked; extended soak tests and production capacity claims remain outstanding. |
| Invalid inputs and protocol errors | `test/scenario.test.ts`, host validation tests and selected Java validation cases. | The service and browser protocol matrices below cover rejection, continued processing, acknowledgements and timeouts. Broader schema fuzzing, resource limits and permissions remain separate work. |
| Demo rendering | `test/browser/assertions.test.ts`, vehicle/state tests and viewer-controls tests inspect DOM/SVG; deliberately broken rendering fails despite correct receipts. | These verify the demo's representation, not general consumer UIs or visual quality across browsers. |
| Resource and platform behaviour | Bounded reconnect/reset workloads, Java queue/writer cleanup and history observations; native lifecycle jobs and browser-engine recovery probes described below. | Extended soak/profiling, every OS/engine combination and mobile devices remain unverified. |

## Projection extraction checks

`ViewConfigurationTests` exercises missing/malformed resources, invalid startup
configuration, duplicate startup IDs and malformed runtime definitions through
`ViewStore`. Rejected definitions leave their IDs available and register no
matching state. `ViewSnapshotOwnershipTests` mutates source payloads, returned
change notifications and queried snapshots for all three field policies; none
may alter the store's nested values. The new cases pass against both the original
store and its extracted collaborators. Existing ordering/reference and real
transport checks continue to protect projection behaviour.

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
one seed from `zooglass`:

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
explored. Automatic retries and the proxy fault gate have separate browser integration coverage.

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

`DeliveryFailureTests.java` protects serialisation failure, write failure followed
by close failure, and a late failure from a replaced writer. The tests first passed
against the original broadcaster, then against the extracted subscription index
and outbound writer. They check removal, healthy-peer delivery, re-registration
and replacement-writer survival through the broadcaster interface. Resource tests
still inspect both membership maps inside the subscription index and the writer
registry, checking queue release and cancellation as before.

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
Existing `test/scenario-session.test.ts` and `test/zooglass-session.test.ts` cases still cover partial client/source setup,
cleanup continuing when one executor close fails, startup failure and cancellation;
`test/controller-lifecycle.test.ts` checks that failed cleanup prevents replacement.

## Sustained activity and resource ownership

Run the additional bounded lifecycle workload from Workbench:

```sh
npm run test:resources
```

It uses JDK 25 and installed Chromium, runs serially, and is separate from both
coverage suites. CI runs it after the browser suite. These two cases perform:

- Fifty real client connections/reconnections, each consuming a burst of 25
  updates. Every new subscription after the first must receive current state.
  Each close leaves a closed socket, an empty consumed receipt buffer and no
  connection-acquisition listener on the shared caller cancellation signal.
- Five complete browser demo runs, alternating mouse and keyboard Reset after the initial host-side start, each with an empty service
  baseline and two checked steps. Old browser connections and pages close; old
  host/service addresses stop responding. Final shutdown is checked too.

Java `ResourceBehaviourTests` runs with normal Maven verification. Across 100
blocked-writer sessions, each with 25 queued updates, removal must interrupt the
writer and empty its queue plus all three subscription/writer registries. The
executor must terminate after broadcaster shutdown. This uses white-box checks
of resource ownership: they will need updating if those internals are refactored,
but should retain the same cleanup guarantees.

A separate history workload grows to 100, 500 and 1,000 positions and replays all
received positions at each checkpoint. It checks exact ordered contents, unchanged
state after duplicates, and serialized size below `64 × positions + 256` bytes
for this deliberately small sequence-only fixture. That generous linear bound is
a regression check for this fixture, not a limit on application payload sizes.

Maven writes `target/resource-observations.json`, included in the
`zooglass-coverage` CI artefact alongside `site/jacoco/`. It contains position
counts, serialized state size and JVM heap-used observations. In the initial local
run on JDK 25.0.5.0.2, serialized snapshots were 1,652, 8,452 and 16,953 bytes;
heap-used observations were approximately 90, 75 and 134 MB respectively.
Heap observations include temporary allocations, other tests and garbage
collection timing. There is deliberately no flat-heap assertion or arbitrary
heap tolerance; the decreasing middle sample illustrates why that would mislead.

These tests distinguish intended retained history from reachable queues and
subscriptions that should disappear. They do not measure retained object size,
prove an absence of every memory leak, or establish long-running throughput.
History still grows without a production retention policy. Resource workloads
are bounded and reproducible; extended soak/profiling remains a separate diagnostic
if later evidence calls for it.

## Platform and browser scope

The normal demo launcher owns a Playwright Chromium process. It has no browser
selection option. CI uses the pinned Playwright version and current GitHub-hosted
runner images, with Node 26 and JDK 25:

| Environment | Checks |
| --- | --- |
| Ubuntu / Chromium | Full standard and browser suites, plus bounded resource workloads. |
| macOS / Chromium | Fifty real reconnects and five complete demo runs, including mouse/keyboard Reset and shutdown. |
| Windows / Chromium | The same native lifecycle workload, including real JVM process-tree termination. Simulated Windows shutdown tests remain separate unit evidence. |
| Ubuntu / Chromium, Firefox, WebKit | Focused real-service recovery fixture: late and duplicate delivery, disconnect, updates while offline and current snapshots after reconnection, with independent rendered checks. |

The engine probe uses the existing browser host and executor directly; it does
not add another production launcher. From Workbench, install the desired engine
and run the probe (Chromium is the default):

```sh
npx playwright install --with-deps firefox
WORKBENCH_TEST_ENGINE=firefox npm run test:engines
```

In PowerShell, set `$env:WORKBENCH_TEST_ENGINE = "firefox"` before
`npm run test:engines`. Use `webkit` or `chromium` for the other engines.
`npm run test:resources` reproduces the native lifecycle workload.

These are specific CI scopes, not a complete OS/browser support matrix. Firefox
and WebKit are compatibility probes, not supported choices in the interactive
launcher. Branded Chrome/Edge, installed Safari, mobile Safari/iOS, Android,
headed desktop interactions and other OS/version combinations are not verified
by these jobs. Playwright WebKit on Ubuntu is not proof of Safari behaviour.

Reset checks register for page closure before input, tolerate only the recognised
closed-target input errors after closure, and wait for a different ready run.
These include the Windows `locator.click: Browser closed` message.
`test/demo-unit/reset-input.test.ts` checks both recognised forms, rejection while the old
page is open, continued waiting for replacement readiness and propagation of
unrelated input errors.
Other input failures still fail. Readiness polling has a deadline and reports
controller state; it does not guess a startup delay. The five-run workload repeats
both mouse and keyboard Reset twice and verifies old endpoints are unavailable.
There are no automatic test retries. Independent matrix jobs continue after a
failure so one platform cannot hide results from another.

Failures retain test output. Reset failures additionally attempt to save controller
state and a screenshot; recovery-probe failures attempt a screenshot and Playwright
trace under `test-results/`, uploaded by CI. Launch failures may have no page or
trace to capture. Open a downloaded trace with `npx playwright show-trace <file>`.

## Work that follows

The [verification review](verification/2026-10-25.md) records fresh-checkout
results, coverage changes, deliberate regression checks and remaining gaps. It
was accepted in [PR #46](https://github.com/sproates/zooglass/pull/46). The
[readability plan](plans/readability-refactor.md) maps proposed extractions to
protecting tests and keeps core protocol verification independent of demo UI checks. Real data-path fault injection and automatic retry now have focused browser
coverage, including outage reset and deadline expiry. Permissions remain future
feature work; these tests do not establish authorisation behaviour.

Use the stronger suite to protect subsequent readability refactoring. Production
and test modules both need clear responsibilities, explicit lifecycle ownership
and manageable complexity. Keep refactors reviewable and preserve behaviour;
coverage percentages alone aren't the acceptance criterion.


## Scenario parser refactor checks

`test/scenario-validation.test.ts` protects validation order, duplicate runtime
view declarations, forward references and input timeline order. It also preserves
the different null rules for HTTP and client view checks. These tests passed
against the original parser before extraction and exercise the public
`parseScenario` entry point. The existing every-scenario integration tests still
execute fixtures through Workbench and the real service.

The later composition extractions and independent core command are described in
the [readability plan](plans/readability-refactor.md).


## Run coordination refactor checks

`test/session-http.test.ts` exercises the session through a local HTTP server.
It checks encoded view/entity paths, polling through unavailable or stale results,
absence checks, malformed JSON followed by a successful action, and definition
request bodies and status handling. These cases passed before moving the HTTP
operations to `view-http.ts`.

`test/demo-step-groups.test.ts` checks setup, source and connection checkpoints
through the controller, including reset to the first step and rejection of a demo
with no source event. These cases also passed before extraction. Pure planner
checks then protect the delay from the previous checkpoint's final timestamp,
equal-time boundaries and the first delay when there is no setup.

Existing controller tests retain pause/resume timing, overlap rejection, failure
handling and the six-boundary reset/close matrix. The extraction does not change
timer ownership or replace Workbench's orchestration.


## Browser composition checks

`test/browser-host.test.ts` supplies an inventory identity and in-memory HTML.
Existing origin, route-token, registration, duplicate-client and control-loss
checks therefore exercise the host without vehicle assets. It also verifies
that the supplied page is served and an unsupplied vehicle script returns 404.

`test/browser/composition.test.ts` supplies a minimal non-vehicle page and script
to the owned browser session. A local WebSocket upstream sends an inventory
receipt; the existing browser executor and scenario session verify it. The test
checks registration, cleared URL credentials and host/page cleanup. The fixture
now imports the shared browser bridge, supplying only a small data client. This
establishes shared-bridge composition but not ZooGlass projection correctness;
existing real-service scenario suites continue to cover those service interactions.

Vehicle browser checks retain their assertions and now explicitly select the
vehicle composition module. The independent core command is described below.


## Shared bridge protocol checks

`test/browser-bridge.test.ts` drives registration and commands with a fake control
socket and injected client. Six cases protect cached completion replay, mismatched
ID reuse, stale identities, invalid commands, overlapping actions, failure/retry,
the 256-command bound and client cleanup on control loss. These wire-contract
checks passed against the original bridge before extraction and against the
shared function afterwards. The final fixture needs no DOM or vehicle module.

The inventory browser composition test now uses the shared bridge. Existing
vehicle browser tests continue to exercise controls, rendered state, recovery
and cleanup through the vehicle bootstrap. Bridge code is behaviourally checked
but remains outside the c8 `src/**/*.ts` coverage scope.


## Client binding checks

`test/demo-unit/subscription-client.test.ts` loads the compiled protocol module with a
controlled socket and an inventory binding, without a DOM. Eight cases cover
non-vehicle subscriptions and callback-before-receipt ordering, application
policy rejection without a socket write, snapshot callback failure, stale socket
callbacks after reconnect, and pending acknowledgement rejection on connection
loss. Review regressions also cover a throwing connected-state callback, a
throwing error-state callback during cleanup, and a throwing subscription callback
while its acknowledgement is pending. Each command must reject and the socket
must close rather than leaving the command pending. Existing browser tests still
check real transport and the vehicle renderer.
These focused checks are protocol boundary evidence, not a substitute for those
integration checks. The browser module remains outside the current c8
`src/**/*.ts` coverage scope and requires the existing browser TypeScript build.
The independent core command is described below.


## Shared demo ownership checks

`test/demo-unit/automatic-demo.test.ts` protects browser/scenario startup failure, execution
failure, visible inspection before teardown, interruption during delay or the
completion wait, and cleanup after scenario closure fails. These eight cases
passed against the original automatic path before the shared run extraction.
`test/demo-unit/vehicle-run.test.ts` adds four checks for repeated open/close, closure without
a scenario, aggregation of cleanup errors and cancellation of pending setup.

The small fixture in `test/support/automatic-demo.ts` transpiles the real entry
point and run owner with controlled service/browser/session boundaries. It tests
control flow without starting a second orchestration system. These VM checks do
not contribute source coverage to c8. Existing real-browser tests, including
interactive and automatic CLI interruption, retain process and transport evidence;
the controlled cases are not substitutes for those integration checks.


## Independent verification and reuse evidence

| Command | Scope | Vehicle build | Browser engine |
| --- | --- | --- | --- |
| `npm run test:core` | Scenario, real service/protocol, controller, Node host and controlled bridge checks | No | No |
| `npm run test:demo-unit` | Demo assembly, reset helper and browser subscription client unit checks | Yes | No |
| `npm test` / `npm run test:coverage` | Both groups above, preserving the standard suite/report | Yes | No |
| `npm run test:browser` | Real browser transport and demo rendering integration | Yes | Chromium |

Verified on 25 October 2026 in a fresh checkout before any vehicle build:
`npm ci`, then `PLAYWRIGHT_BROWSERS_PATH=<fresh-absolute-directory> npm run test:core`.
All 95 core tests passed. The temporary browser directory was empty before and
after the run, and `demos/vehicle-tracker/dist` did not exist before or after.
No browser executable path or branded channel bypass occurs in the core execution
path. The Playwright npm package can remain installed as a development dependency;
the core command neither installs nor launches its engines.

The 24 relocated demo-unit tests remain in the full 119-test standard suite.
The same assertions are retained; only their relative imports and suite selection
changed. CI collects coverage during the empty-cache/no-build core check, then
adds demo-unit coverage with c8's `--clean=false`. Each group runs once; the
second report combines both groups. The core check still precedes any vehicle
build, preventing a previous build from masking a new core dependency.

### CI turnaround

Linux browser jobs use the official Playwright image, with browsers and system
libraries already installed. Keep its version in `.github/workflows/workbench.yml`
aligned with the pinned Playwright package when upgrading. This removes the
per-job system package installation; pulling the image still depends on the
network. Container Maven runs use GitHub's mounted home directory so dependency
and wrapper downloads use the repository restored by `setup-java`. macOS and
Windows lifecycle jobs continue to run natively. Each job packages ZooGlass once
before starting service tests. Parallel sessions then launch the same JAR without
Maven or compilation; the tests themselves remain concurrent. Native lifecycle
jobs also check concurrent artifact-only launches from a path containing spaces.

New PR revisions share a concurrency group and cancel obsolete runs for that PR.
Each main-branch push uses its unique run ID, so neither running nor pending
main runs are superseded by this concurrency policy. The seven verification
jobs and their test scopes remain unchanged.
Existing path filters exclude changes confined to root documentation, but changes
under the three component directories still run the full Workbench workflow.

Compare job setup time and test time separately when changing CI. Do not remove
behavioural checks to improve a timing number. The PR #57 reference run took
3 minutes 34 seconds for standard verification, including a redundant 93-second
core run. Its WebKit dependency download stalled for over 14 minutes; retrying
the job took 1 minute 19 seconds. These are individual observations, not a timing
guarantee or an agreed performance budget.

Dependency review finds concrete vehicle assets/IDs and rendered observers in
the vehicle composition modules and demo entry points. The scenario, transport,
host, bridge and controller modules do not import those bindings. The existing
all-scenario test still executes non-vehicle scenarios (including order fulfilment
and sports betting) through real ZooGlass. The inventory browser fixture uses the
shared host, bridge, executor and ScenarioSession with its own assets and identity;
it verifies receipts and cleanup, not a second showcase UI. These establish the
planned dependency/reuse boundaries without introducing a plugin system.


## Test organisation

The core tests remain selected by `test/*.test.ts` and `test/scenarios/*.test.ts`.
The former mixed controller and session files are grouped by responsibility:

| File | Behaviour under test |
| --- | --- |
| `controller-lifecycle.test.ts` | Step completion, replacement, startup cancellation and cleanup failure |
| `controller-playback.test.ts` | Play/pause timing, ordering and failure |
| `controller-interventions.test.ts` | Manual actions, exploratory state and reset |
| `demo-controller-races.test.ts` | Reset/close at the six execution boundaries |
| `scenario-session.test.ts` | Client/source binding, cancellation and session cleanup |
| `zooglass-session.test.ts` | Child-process health, termination and configuration cleanup |
| `module-imports.test.ts` | Importing reusable modules has no startup side effects |

Small helpers in `test/support/` supply explicit gates, a local HTTP/WebSocket
peer and a process fixture. The process itself is readable JavaScript under
`test/fixtures/process/`, rather than code embedded in a string. Tests still own
the action sequence and expected results; helpers do not calculate expected view
state or introduce another scenario runner. Cleanup hooks release gates and close
sessions even when an assertion fails.

The existing browser reconnection group and Java functional tests retain their
cohesive protocol scenarios. They have bounded setup/cleanup and independent
assertions; splitting them solely to reduce line counts would scatter related
behaviour. Pause timing checks retain real elapsed-time assertions because elapsed
time is the behaviour being tested.


## Refactor acceptance

The [26 October refactor review](verification/2026-10-26-refactor.md) records the
post-extraction fresh-checkout results, dependency and ownership review, coverage
comparison, CI turnaround and remaining harness risks. The earlier review remains
the pre-refactor baseline; neither document is a live test-status dashboard.


## Vehicle recovery acceptance

The [recovery acceptance record](verification/2026-10-26-recovery.md) maps the
six deliberate-action steps and unexpected connection-loss scenario to their
service, transport and browser evidence. It records the checked source revision
and keeps whole-demo acceptance and broader recovery guarantees separate.


## Prebuilt service launch boundary

Before running Workbench service, browser, resource or engine tests, run
`npm run prepare:service` from `workbench`. It packages
`zooglass/target/zooglass.jar` using the Maven wrapper, skipping Java
test compilation/execution. Java tests remain a separate `./mvnw verify` step.
The CI jobs each prepare once before their test commands; no test-session or
Reset path invokes the build. The same boundary applies to connected CLI runs
and the vehicle demo. Print-only simulation and demo-unit checks do not need it.

Startup checks that the JAR exists, then launches Java directly with per-session
ports and temporary view configuration. `JAVA_HOME/bin/java` is preferred when
set, otherwise `java` must be on PATH. There is no freshness check against source
files: rebuild explicitly after Java changes and stop sessions before replacing
the artifact. A missing artifact produces preparation instructions, not a hidden
build. Build failures therefore happen during preparation, before concurrent tests.

`test/prebuilt-service.test.ts` copies only the JAR into a path containing spaces,
starts two sessions concurrently with different definitions, checks state isolation,
then replaces a session and checks fresh state. The directory has no Maven wrapper,
POM or sources. It verifies the artifact is unchanged and no build outputs appear.
Existing startup-failure, cancellation, forced shutdown and browser Reset/resource
checks retain their responsibilities. Native Windows lifecycle results come from
CI; POSIX process fixtures and mocked Windows decisions are separate evidence.

Earlier verification records describe their historical Maven launch path. This
change replaces that path rather than masking concurrent compilation with retries
or serialising tests. The process launcher cannot write shared Java class files
because it does not start a compiler.

Local validation of this change on macOS with Node 26 and JDK 25: explicit JAR
preparation, 138 standard tests, 46 browser tests, both resource workloads and
106 Java tests passed. Type checks, lint, formatting and the Workbench build
also passed. The artifact-only test passed again after its failure-cleanup
handling was tightened. Native Windows and Linux engine evidence is supplied
by the PR's CI; local results do not substitute for those runs.
