# Contributing to ZooGlass

Focused fixes, useful scenario cases and documentation improvements are welcome.
ZooGlass is an early prototype, with direction set by the maintainer. Start with
[what we're trying to build](docs/what-is-zooglass.md) and the
[roadmap](ROADMAP.md) to understand the intended scope and current priorities.
A proposed contribution doesn't by itself commit the project to supporting a
new feature or integration.

## Contribution requirements

These requirements apply to every contribution, including AI-assisted work.

- **Roadmap changes require repository-owner approval.** Propose changes to
  [ROADMAP.md](ROADMAP.md) with their rationale and evidence; approval is required
  before they are merged or treated as agreed project direction.
- **Discuss substantial contributions before implementing them.** Open a small
  draft PR describing the problem, scope, trade-offs and intended verification,
  and agree the scope with the maintainer. This includes large refactors.
- **Keep PRs focused and manageable.** Make each PR reviewable as a coherent
  change. Split larger work into agreed increments; exclude unrelated cleanup.
- **Use clear, professional English** in PR descriptions and review comments.
- **Follow the [Java](#java) and [TypeScript](#typescript) coding standards.**
  The same readability requirements apply to production and test code.
- **Bug fixes need a regression test that fails before the fix and passes after
  it.** Verify that the failure demonstrates the original bug and record the
  evidence. If automation is impractical, explain the exception and alternative
  verification. See [Tests and bug fixes](#tests-and-bug-fixes).
- **Validate the change and report the results.** Cover relevant behaviour,
  failures and boundaries; state what could not be verified and why.
- **Update affected documentation and diagrams in the same PR**, including guides,
  configuration examples and source maps.
- **Justify new dependencies and check licence compatibility.** Submit only
  material you have the right to contribute, and never include secrets.

Suspected vulnerabilities must use the private route in [SECURITY.md](SECURITY.md).

## AI-assisted contributions

AI-assisted contributions are welcome. All contributions must meet the standards
in this guide, regardless of how they were produced. Contributors are responsible
for understanding, reviewing and validating what they submit, and for responding
to review feedback. Check generated explanations, references and claims about
test results for accuracy.

You don't need to identify the tools you use or label AI-generated passages.
Responsibility for the contribution remains with the contributor.

## Set up a checkout

Use JDK 25 for ZooGlass and Node 26 for Workbench Scenario Simulator, or Workbench
for short. The Maven Wrapper downloads Maven as needed. Initial builds also
need network access for Maven and npm dependencies.

From the repository root, install Workbench dependencies:

```sh
cd workbench
npm ci
```

The [prototype guide](zooglass/README.md) describes the service and
protocol. The [Workbench guide](workbench/README.md) covers scenarios,
CLI commands and shared sessions. Source and tests live under their respective
`zooglass` and `workbench` directories; project explanations
and designs live under `docs/`. The browser app lives in `demos/vehicle-tracker`
and uses Workbench's build and check commands.

## Make a focused change

Create a descriptive branch from up-to-date `main` and target the PR at `main`.
For example, use `fix/client-reconnect`, `feature/view-metadata` or
`docs/scenario-guide`. Keep unrelated formatting, renaming and behaviour changes
out of the diff.

## Coding standards

Write code for people to understand and maintain. Use clear names, cohesive
modules and straightforward control flow. Keep functions and files focused;
split unrelated responsibilities rather than imposing an arbitrary line limit.
Prefer names and comments that explain purpose, ownership and failure behaviour.
Document assumptions about event identity, ordering and connection lifecycle
when they affect callers. Apply these standards to production and test code.

### Java

Use these conventions for Java changes:

- **Layout:** use four spaces, no tabs, and opening braces on the declaration or
  control-flow line. Use braces for conditional and loop bodies. Separate logical
  steps with blank lines; wrap long expressions where it helps explain them.
- **Names and imports:** use `UpperCamelCase` for types, `lowerCamelCase` for
  methods and variables, and `UPPER_SNAKE_CASE` for constants. Package names are
  lowercase. Import explicit types rather than using wildcard imports.
- **Types and visibility:** use parameterised collections, not raw types. Keep
  members private unless callers need access. Use records for value carriers
  where appropriate; remember that a record does not make nested objects immutable.
- **State:** prefer final fields and local variables where reassignment is not
  needed. Make ownership of mutable collections and JSON explicit. Do not expose
  internal mutable state through a returned value; copy or provide a suitable
  immutable representation.
- **Construction and resources:** supply service dependencies through constructors.
  Use try-with-resources for owned `AutoCloseable` resources where their lifetime
  fits the scope; otherwise make the close responsibility explicit.
- **Failures and concurrency:** catch specific exceptions where recovery or useful
  translation is possible. Do not swallow failures or misreport internal errors as
  invalid input. Document which lock or thread owns shared state; avoid blocking
  network I/O while holding shared state locks.

The Maven verification command below compiles and tests Java. There is currently
no configured Java formatter or style checker, so these conventions also require
review; a successful build does not establish style compliance.

### TypeScript

Use these conventions for TypeScript changes:

- **Formatting:** use Prettier's project formatting: two-space indentation, double
  quotes and semicolons. Run the existing formatter rather than hand-tuning its
  output. Use blank lines between logical steps without separating every statement.
- **Names and modules:** use `UpperCamelCase` for types and interfaces,
  `lowerCamelCase` for functions and variables, and descriptive kebab-case module
  filenames. Group modules by responsibility and keep exports limited to what
  callers need.
- **Imports:** use ES modules and `import type` for type-only dependencies. Use
  `.js` extensions in relative imports under the existing NodeNext configuration.
- **Contracts:** name substantial options objects and shared data contracts.
  Prefer union types for a closed set of states and discriminated unions when
  those states carry different data. Use `readonly` where callers must not mutate
  a contract. Keep obvious local shapes inline and allow inference when it is clear.
- **Type safety:** keep strict compiler checking enabled. Use `unknown` and runtime
  validation for untrusted input. Do not use `any`, non-null assertions or casts to
  conceal a missing check. Any necessary suppression must be narrow and explain
  why it is safe.
- **Control flow:** prefer `const`; use `let` only for reassignment and avoid `var`.
  Prefer straightforward branches over nested conditional expressions. Handle
  promise failures and make ownership of background tasks, listeners and timers
  explicit, including their cleanup.

Run `npm run lint`, `npm run format:check` and `npm run typecheck` from `workbench`.
The [ESLint configuration](workbench/eslint.config.js) and
[compiler configuration](workbench/tsconfig.json) enforce part of these standards;
review still needs to assess readability, ownership and correctness. Don't disable
checks merely to make a change pass.

### Responsibilities and dependencies

ZooGlass owns reusable view maintenance, reconciliation and delivery behaviour.
Workbench generates scenario inputs and faults and verifies outcomes through
ZooGlass's interfaces. Demos own presentation and domain-specific application
rules; they must not recreate the ZooGlass behaviour they demonstrate.

When introducing or changing configurable strategies, represent each strategy in
a named, cohesive module. Configuration must select the implementation actually
used at runtime. Keep selection separate from the strategy's behaviour.

Explain why a new dependency is needed, consider its maintenance and runtime
cost, and check licence compatibility. Only submit material you have the right
to contribute. Never include secrets in code, fixtures, logs or documentation.

## Tests and bug fixes

Tests must assert observable behaviour with expected results independent of the
implementation. Cover relevant failure paths, boundaries and interactions as well
as the successful case. Keep tests deterministic, bound waits, and clean up
processes and connections.

For a bug fix, wherever practical, include a regression test and verify that it
fails because of the original bug before the fix and passes afterwards. Record
that evidence in the PR. If an automated regression test is impractical, explain
why and describe the alternative verification.

Use Workbench scenarios when behaviour spans source events, service processing
and client receipt; keep isolated component checks with the component. Do not
manufacture received view state from the test's expected values.

Keep validation proportionate without weakening coverage. Reuse valid build
artifacts and avoid duplicate test runs. If a change noticeably slows validation
or CI, investigate and address the cause as part of the change.

## Validate your change

Run checks for the affected components and record the commands and results in
the PR. Changes to ZooGlass behaviour can also affect Workbench scenarios, so
validate both when the shared protocol or view semantics change.

For the Java service, from the repository root:

```sh
cd zooglass
./mvnw --batch-mode verify
```

For Workbench, from the repository root:

```sh
cd workbench
npm ci
npm run prepare:service
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
`npm run prepare:service` packages the executable JAR without running or compiling
Java tests. Run `./mvnw verify` separately for Java verification. Repeat preparation
after Java source/resource/dependency changes and stop running sessions before
replacing the shared JAR. Tests and Reset launch that artifact directly, never
Maven; a missing artifact fails with preparation instructions.
Use `npm run format` in that directory to apply formatting, then inspect the diff
for unrelated edits. On Windows, use `mvnw.cmd` in place of `./mvnw`.

For documentation-only changes, check local links and examples, inspect any
changed diagrams after rendering, and run applicable formatting checks. There
is no single root-level application test command. CI selects checks by change
impact and reports them through `validation-gate`. Read the selection summary:
not-applicable and deliberately deferred suites have not passed. The
[validation guide](docs/ci-validation.md) explains selection, bounded integration
batches and full checkpoints. No reported check is not evidence of success.
If a check cannot run, say what remains unverified and why.

## Inspect coverage and verification gaps

`./mvnw --batch-mode clean verify` in `zooglass` produces the JaCoCo
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

Write PR descriptions and review comments in clear, professional English.
Explain the problem and resulting behaviour, with a concrete example where it
helps. Include validation evidence and material limitations. Use the PR template
as a prompt, keeping the description proportionate to the change.

Update affected guides, configuration examples and source/architecture diagrams
in the same PR. Follow the owner-approval requirement above for roadmap changes,
and keep proposed work distinct from completed delivery. Preserve the distinction
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
