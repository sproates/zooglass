# Contributing to ZooGlass

Focused fixes, useful scenario cases and documentation improvements are welcome.
ZooGlass is an early prototype, with direction set by the maintainer. Start with
[what we're trying to build](docs/what-is-zooglass.md) and the
[roadmap](ROADMAP.md) to understand the intended scope and current priorities.
A proposed contribution doesn't by itself commit the project to supporting a
new feature or integration.

For a substantial feature, open a small draft PR with a written proposal before
investing in the implementation. Explain the problem, intended behaviour,
trade-offs and how the result could be demonstrated. Keep ordinary bug fixes
and documentation changes proportionate. Suspected vulnerabilities must use the
private route in [SECURITY.md](SECURITY.md).

## Set up a checkout

Use JDK 25 for ZooGlass and Node 26 for Workbench Scenario Simulator, or Workbench
for short. The Maven Wrapper downloads Maven as needed. Initial builds also
need network access for Maven and npm dependencies.

From the repository root, install Workbench dependencies:

```sh
cd incubator/workbench
npm ci
```

The [prototype guide](incubator/zooglass/README.md) describes the service and
protocol. The [Workbench guide](incubator/workbench/README.md) covers scenarios,
CLI commands and shared sessions. Source and tests live under their respective
`incubator/zooglass` and `incubator/workbench` directories; project explanations
and designs live under `docs/`. The browser app lives in `incubator/vehicle-tracker`
and uses Workbench's build and check commands.

## Make a focused change

Create a descriptive branch from up-to-date `main` and target the PR at `main`.
For example, use `fix/client-reconnect`, `feature/view-metadata` or
`docs/scenario-guide`. Keep unrelated formatting, renaming and behaviour changes
out of the diff.

Follow the surrounding Java conventions. Workbench uses TypeScript with ESLint
and Prettier. Prefer names and comments that explain purpose, ownership and
failure behaviour. Document assumptions about event identity, ordering and
connection lifecycle when they affect callers.

Tests should assert observable behaviour. For a fix, include a focused regression
case where practical. Use Workbench scenarios when the behaviour spans source
events, service processing and client receipt; keep isolated component checks
with the component. Bound waits and clean up processes and connections in tests.
Do not manufacture received view state from the test's expected values.

## Validate your change

Run checks for the affected components and record the commands and results in
the PR. Changes to ZooGlass behaviour can also affect Workbench scenarios, so
validate both when the shared protocol or view semantics change.

For the Java service, from the repository root:

```sh
cd incubator/zooglass
./mvnw --batch-mode verify
```

For Workbench, from the repository root:

```sh
cd incubator/workbench
npm ci
npm run lint
npm run format:check
npm test
npm run build
```

For service/protocol work without a vehicle build or installed browsers, use
`npm run test:core`. Demo-specific unit checks are separately available through
`npm run test:demo-unit`; they build vehicle assets but launch no browser.
`npm test` retains both groups and the standard coverage command retains its
combined report.

For browser-host or vehicle-app changes, also run from Workbench:

```sh
npx playwright install chromium
npm run test:browser
```

On Linux, use `npx playwright install --with-deps chromium` if browser system
packages are needed. These tests launch an owned Chromium session.

The Workbench suite starts real ZooGlass processes, so it also needs JDK 25.
Use `npm run format` in that directory to apply formatting, then inspect the diff
for unrelated edits. On Windows, use `mvnw.cmd` in place of `./mvnw`.

For documentation-only changes, check local links and examples, inspect any
changed diagrams after rendering, and run applicable formatting checks. There
is no single root-level test command. CI runs the component checks selected by
the workflow path filters; no reported check is not evidence that tests passed.
If a check cannot run, say what remains unverified and why.

## Inspect coverage and verification gaps

`./mvnw --batch-mode clean verify` in `incubator/zooglass` produces the JaCoCo
report at `target/site/jacoco/index.html`. In Workbench, `npm run test:coverage`
and `npm run test:browser:coverage` produce separate reports in
`coverage/standard/` and `coverage/browser-host/`. Both commands run their tests;
there's no need to run the equivalent uninstrumented suite again.

For sustained lifecycle and cleanup changes, also run `npm run test:resources`
from Workbench. It requires Chromium and runs bounded reconnect/reset workloads
separately from the coverage suites.

See the [verification map](docs/testing.md) for report boundaries, the measured
baseline and gaps. Coverage reports show execution, not whether assertions are
strong enough. Keep tests readable and expected results independent of the
implementation they check.

## Open the pull request

Explain the problem and resulting behaviour, with a concrete example where it
helps. Include validation evidence and material limitations. Use the PR template
as a prompt, keeping the description proportionate to the change.

Update affected guides and examples in the same PR. If a milestone or delivery
direction changes, update [ROADMAP.md](ROADMAP.md) with the status and evidence;
keep proposed work distinct from completed delivery. Preserve the distinction
between current behaviour and planned capabilities in prose and diagrams.

Maintainer review determines whether a change fits the project and is ready to
merge. A passing check doesn't replace review. Keep discussion respectful,
explain disagreements in terms of behaviour and evidence, and give reviewers a
clear account of what changed when responding to feedback.

## Include enough information to reproduce a problem

A bug report or regression PR should identify the commit, operating system,
Java and Node versions where relevant, exact command, smallest useful scenario,
expected result and actual result. Sanitise logs and fixtures; don't include
credentials or personal data. A draft PR containing a failing scenario is useful
even if you haven't worked out a fix yet.

## Licence

ZooGlass uses the [MIT licence](LICENSE). Contributions are intended to be
provided under that same licence. Only submit material you have the right to
contribute, and preserve applicable third-party notices when adding or adapting
code, documentation or assets.
