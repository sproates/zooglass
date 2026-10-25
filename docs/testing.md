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
| Subscription, late delivery, duplicates and reconnect snapshots | Java functional tests, Workbench scenario execution and `test/browser/recovery-fixture.test.ts` exercise real connections. | Subscription/update races, stale callbacks, delayed or absent snapshots and cancellation at each boundary. |
| Per-view freshness and retained data | `test/browser/states.test.ts` controls snapshot arrival and connection failures, including independent latest/history freshness. | More arrival permutations and old-generation events during replacement. Browser behaviour is tested but not instrumented for coverage. |
| Controller and executor lifecycle | `test/demo-controller.test.ts`, `sessions.test.ts`, `browser-client-executor.test.ts` and browser lifecycle tests cover overlap rejection, cancellation, reset, partial setup and cleanup failures. | A systematic transition/failure matrix; current examples don't establish every interleaving. |
| Slow-client protection | `LiveViewBroadcasterTests.java` uses blocked mock writes to exercise bounded queues and event processing. | Real multi-client transport isolation under sustained load, including a healthy client beside a slow one. |
| Invalid inputs and protocol errors | `test/scenario.test.ts`, host validation tests and selected Java validation cases. | A contract-based invalid-message matrix, duplicate/unexpected acknowledgements and partial protocol failures. |
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
