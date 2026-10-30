# CI selection and development workflow

Status: selection is delivered in PR #107; this revision adds batch checkpoints.
The baseline audit below describes the former workflows at `2cc15cd`.
[Validation](../.github/workflows/ci.yml) runs on PRs to main/integration branches,
main pushes and manual dispatch. Java and Workbench are reusable selected suites.

The [classifier](../.github/ci/selection.mjs) maps paths to checks. The
[batch policy](../.github/ci/batches.json) is read from trusted main. The final
`validation-gate` rejects failed, cancelled, skipped or missing selected jobs.
Its summary distinguishes deferred checks from passed and not-applicable checks.
The plan artifact records the compared revisions and actual tested commit.

[Verification contracts](testing.md) describe what the tests establish.

## Using the workflow

- Normal PRs get the selected checks automatically. No skip label is needed.
- To start a core batch, submit a small policy PR naming the exact integration
  branch, repository, owner, reason, expiry and final checkpoint. Merge that policy
  before creating slice PRs. Configure `validation-gate` as required on the batch
  branch, as on main. Policies expire automatically and never apply to forks.
- Open small slice PRs into the named integration branch. Review the selection
  summary: Java/Node checks still run; only eligible slow checks are deferred.
- A PR from `integration/*` into main always selects all suites. Refresh it if main
  changes, require the green gate, then merge and remove the policy entry.
- Main pushes run selected fast checks without automatically repeating the slow
  matrix. Releases and manual checkpoints run full verification at the exact SHA.

Manual full checkpoint (also the default in GitHub's Run workflow form):

```sh
gh workflow run ci.yml --ref integration/strategy-core -f mode=full
```

For selected validation, provide the comparison ref explicitly when needed:

```sh
gh workflow run ci.yml --ref feature/example -f mode=selected -f compare_ref=origin/main
```

Run the classifier/policy/gate tests locally with
`node --test .github/ci/*.test.mjs`. They need Node but no installed npm packages,
JVM or browser. Use the existing component commands for selected behavioural work.
Partial coverage reports describe only that selected run; compare full checkpoint
coverage for overall coverage trends.


## Recommendation

Select checks by the behaviour a change can affect. Keep Java and real-service
protocol verification on core changes; stop treating every change as a browser,
platform and demo change.

For a coherent batch of core work, use an explicitly configured integration
branch with small PRs into it. Permit browser and platform checks to be deferred
there, then require full validation before the batch returns to main. End each
batch at a useful, reviewed milestone rather than keeping one branch for the
whole programme.

## Baseline before selection

At the audited baseline, both workflows ran on pushes to `main` and PRs targeting `main`. There is no
manual dispatch, scheduled sweep or configured integration-branch trigger.
PR opened, reopened and synchronised events use GitHub's default PR activity types.

| Changed paths | ZooGlass CI | Workbench CI |
| --- | --- | --- |
| `zooglass/**`, including its Markdown | Java verify | All seven jobs |
| `workbench/**`, including its Markdown | No | All seven jobs |
| `demos/vehicle-tracker/**`, including documentation/media | No | All seven jobs |
| `.github/workflows/zooglass.yml` | Java verify | No |
| `.github/workflows/workbench.yml` | No | All seven jobs |
| Root Markdown or `docs/**` only | No | No |
| Other paths only | No | No |

Paths combine: moving component files and changing their guides still triggers
all applicable jobs. A docs-only follow-up commit to a code PR can also restart
all its jobs because PR path selection considers the PR diff, not just that commit.
Merging a code PR starts another applicable run on main.

Sources: [ZooGlass workflow](../.github/workflows/zooglass.yml),
[Workbench workflow](../.github/workflows/workbench.yml),
[commands](../workbench/package.json).

### Baseline jobs and responsibilities

| Job | Current work | Why it exists |
| --- | --- | --- |
| ZooGlass `test-and-build` | Maven verify, Java tests, JaCoCo report, executable package | Service contracts, concurrency and Java resource behaviour |
| Workbench `test-and-build` | npm install; service preparation; lint/format; core tests with c8; demo-unit tests added to the same report; build | Node scenario/runtime checks and real HTTP/WebSocket integration, plus demo model checks |
| `browser-host` | Playwright container; service preparation; full browser coverage suite; resource tests | Browser transport, hosts, rendered demos and repeated reconnect/reset behaviour |
| `native-lifecycle` × macOS/Windows | Service preparation; Chromium install; prebuilt-service test; resource tests | Native process launch, shutdown, isolation and browser/service cleanup |
| `browser-engines` × Chromium/Firefox/WebKit | Playwright container; service preparation; recovery scenario | Actual engine behaviour with real receipts and rendered state |

The browser-host suite includes both Chromium and WebKit cases; it is not purely
a Chromium rendering suite. Resource tests mix a Node reconnect test with a
browser reset test. Native lifecycle tests partly overlap Linux checks but add
real platform evidence. These are not interchangeable duplicates.

Each Workbench job prepares its own JAR and dependencies. Core tests deliberately
run without built demo assets or installed browsers. The demo-unit prehook builds
browser assets, and the final build builds them again. Browser resource and engine
commands also have build prehooks.

Workbench cancels obsolete PR runs, but keeps separate main-push runs. ZooGlass CI
has no concurrency rule. Neither Linux test job has an explicit job timeout;
native and engine jobs have 15-minute limits. Main's protection API reported
"Branch not protected", and the repository ruleset list was empty during this
audit. Required-check enforcement must therefore be configured explicitly if we
want it enforced by GitHub, rather than only by review practice.

## Measured cost

These are observed job/step durations, not promises or a benchmark across runners.
Queues were short in this sample.

| PR #104 check | Job duration |
| --- | --- |
| Java verify | 31s |
| Workbench standard | 2m39s |
| Browser-host | 5m47s |
| macOS lifecycle | 1m25s |
| Windows lifecycle | 2m36s |
| Engine jobs | 48s–1m01s each |

[PR run](https://github.com/sproates/zooglass/actions/runs/40986119776): core coverage
consumed 118s; browser coverage 265s; browser resource checks 29s. Browser container
initialisation took 20s. Service preparation took 5–11s across the jobs.
The [main run](https://github.com/sproates/zooglass/actions/runs/40986744590) had
102s core coverage and 198s browser coverage, confirming substantial test execution
cost and meaningful run-to-run variance. The separate
[Java run](https://github.com/sproates/zooglass/actions/runs/40986119715) finished in 31s.

Do not infer that c8 alone causes the difference from local uninstrumented runs:
hardware, concurrent service processes and scheduling differ. Compare coverage
on/off and bounded test concurrency on the same runner before changing them.

## Selection matrix

Checks are additive for mixed changes. "Full" means all existing suites, not
necessarily a second invocation of a suite already run for that revision.

| Change | Required per PR | Usually unnecessary for that change |
| --- | --- | --- |
| Prose, diagrams, screenshots and recordings only, wherever located | Local links/anchors, formatting; render changed diagrams | JVM, Node integration, browser and OS suites |
| Java tests only | Java verify | Workbench and browser suites, unless fixtures/contracts also change |
| Internal Java strategies/store logic | Java verify; Node core real-service checks | Demo-unit/rendering, engine matrix and native lifecycle |
| HTTP/WebSocket protocol, serialization, delivery/recovery semantics | Java verify; Node core; browser consumer/recovery checks | Native OS matrix unless launch/lifecycle changes |
| Java packaging, runtime/dependency changes or service launcher | Java verify; Node core; browser-host; native lifecycle | Engine matrix unless browser/dependency compatibility is affected |
| Shared Workbench scenario/execution logic | TS static checks; core integration; affected demo-unit cases | Engine matrix/native jobs if transport/lifecycle untouched |
| Browser host, proxy, bridge, control or reconnect code | TS static checks; core; demo-unit; browser-host and engines | Java verify if Java unchanged; native only for lifecycle impact |
| Demo TS/HTML/CSS or executable scenario/manifest data | TS static checks; demo-unit; affected scenario tests; browser-host and engines | Java verify and native lifecycle unless their boundaries change |
| Native lifecycle/process code | TS static checks; core; browser-host; macOS/Windows lifecycle | Engine matrix unless browser APIs also change |
| Build tools, lockfiles, CI selection/policy, shared fixtures, moved paths or unclassified code | Full until dependencies are explicitly mapped | No blanket exclusions |

The first classifier should be conservative: split known Java strategy/store
files from protocol/lifecycle files; route unfamiliar Java files and resources to
full validation until their role is mapped. Shared test helpers select every suite
that imports them. A `.json` file can be executable scenario/configuration, not
just documentation. Markdown exclusion must not hide mixed code changes.

For core-only slices, keep the complete existing Node core group initially. It
already covers real source ingestion, ordering, subscriptions, invalid input and
concurrent clients. Further selection inside that group needs an explicit test
manifest and evidence that required contracts still run; do not guess by filename.

## Deliberate deferral during core development

### Integration branch, not a global off switch

Use a branch such as `integration/strategy-core` for a bounded milestone. Slice
branches target it through normal PRs. Main stays on the last accepted delivery.

A reviewed policy file on main should identify the exact integration branch,
allowed deferred suites, reason, owner, expiry date and completion checkpoint.
For example: defer browser-host, browser-engines and native-lifecycle during the
named-strategy batch, while Java and Node core checks remain required.

Read policy from trusted main, not the slice PR's version. Match both the base
branch and repository identity so forks cannot acquire a deferral by naming their
branch similarly. No valid entry, invalid policy or expired permission means the
normal matrix applies. Do not disable workflows globally or use `[skip ci]`.

The run summary must distinguish **passed**, **not applicable**, **deferred**, and
**failed**. A deferred suite has not passed. Show its reason and closing checkpoint
on every affected PR.

### What can be deferred

A core-only batch may defer the slow browser and OS suites even while core protocol
behaviour evolves, provided Java and real-client Node tests cover the intended
contract on every slice. Consumer regressions remain possible until the checkpoint;
that is the explicit trade-off for faster iteration.

Direct browser/demo, launcher/lifecycle, dependency, CI or classifier changes
force the suites relevant to those changes, overriding the deferral. A failing
browser check cannot simply be relabelled deferred to hide a known regression;
fix it or record an explicit scoped decision before continuing the batch.

### Closing a batch

1. Open the integration-to-main PR and stabilise the base against current main.
2. Ignore all deferrals on PRs targeting main. Run full validation against the
   integration PR's merged result, including the previously deferred suites.
3. Resolve failures; require a fresh run after any subsequent code/base change.
4. Merge only after the full checkpoint passes. Remove the expired branch policy
   and retire the integration branch. The next batch needs its own decision.

For a long stream, checkpoint after each coherent milestone, before a demo review,
and before expanding into another capability. Use a dated expiry to prevent
indefinite deferral. No need to run browser tests after every small Java refactor.

### Trigger and status design

Replace coarse workflow-level path filters with a cheap always-running selection
job for PRs targeting main and configured integration branches. Diff the merge
base and head, include deletions/renames and union all affected categories.
Use a full Git diff, not a truncated API file list. Missing refs or classifier
errors select full checks or fail visibly, never select nothing.

Use one stable `validation-gate` result with `always()` and explicit inspection
of every selected job result. Fail on missing, failed or cancelled required jobs.
Permit only documented not-applicable/deferred results. Individual skipped jobs
must not accidentally make a failed prerequisite look green.

Add manual `workflow_dispatch` with `full` and `selected` modes. Full bypasses
selection/deferral and records the tested commit and base. Reuse the same suite
implementation, not a separate workflow that drifts. Run the workflow from the
selected branch; no workflow with write secrets should execute untrusted PR code.

Bootstrap these workflow changes on main before starting the integration branch.
Today, PRs into such a branch would receive no checks. Configure the stable gate
as required on main and the chosen integration branch as a separate, explicit
repository setting change; no protection settings have been altered by this audit.

Keep fast selected validation on main pushes. Avoid automatically repeating the
whole browser/OS matrix after every merge: full validation belongs on the final
PR before merge, and manual full runs remain available. If the tested merge base
changes, refresh the final PR first. Releases use a full run on the exact release
commit. Do not claim the squash commit was tested solely because its PR was green.

## Optimisations in delivery order

1. **Selection and controlled deferral first.** This removes unnecessary jobs
   entirely, including browser work on pure docs and core-only changes. Add the
   summary/gate and dispatch together so omitted work stays visible.
2. **Remove repeated preparation within a job.** Build demo assets once when
   needed, with explicit CI entry points. Keep convenience prehooks for developers
   and the rule that tests launch prepared JARs rather than invoking Maven.
3. **Measure test concurrency and coverage cost.** Compare the same revision on
   the same runner class with bounded concurrency values and with/without coverage.
   Retain all assertions. Check wall time, CPU/memory contention and reliability.
   Move full coverage reporting to checkpoints only if measurements justify it;
   required behavioural tests still run on each relevant slice.
4. **Share a JAR only if it improves the critical path.** Packaging is currently
   cheap compared with test execution. An upload/download dependency could make
   the jobs slower; benchmark before adding it. Never reuse an artifact from an
   unrelated revision or persist a mutable shared build directory.

Give superseded Java PR runs cancellation like Workbench, retain separate checkpoint
runs, and add explicit timeouts to long Linux jobs. Do not increase timeouts or add
retries to conceal regressions. Refresh the timings after selection is implemented;
judge the improvement by actual time from push to usable review evidence.

## Focused implementation and acceptance

The implementation is delivered in two reviewable slices:

- **Selection and reporting:** a tested classifier, job-level selection, stable
  gate, scoped static checks and documentation. Retain current full checks for
  broad/unknown changes. Verify docs-only, Java-only, UI-only and mixed PR examples.
- **Batch policy and checkpoint:** integration targets, trusted deferral policy,
  full dispatch, expiry and restoration, and repository gate configuration.
  Demonstrate a deferred slice followed by a fully checked final PR.

Classifier tests must cover renames/deletions, component Markdown, executable
fixtures, shared dependencies, newly added files, mixed changes, invalid policy,
expiry, forks, force-full, and integration-to-main override. Test the gate's
failure/cancellation/missing-result paths. Compare selected suites with the matrix
and inspect actual Actions runs; a unit test of a path glob alone is insufficient.

No tests were deleted, coverage thresholds reduced or browser workflows globally
disabled. No new test framework was introduced.

## GitHub mechanics consulted

- [Workflow triggers and changed-file filtering](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow): PR and push diffs differ; skipped workflow checks can remain pending.
- [PR merge refs](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows): default PR checkout tests the merge result.
- [Manual workflows](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow): dispatch needs a workflow on the default branch and can select another branch.
- [Concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency): cancellation must distinguish obsolete PR work from useful checkpoint runs.
