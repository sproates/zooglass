# Behaviour-preserving code quality review

This review covers Java production and test code, Workbench, the vehicle demo,
repository tooling and the documentation that describes their boundaries.
Existing protocols, strategy semantics, configuration, CLI output and lifecycle
contracts remain unchanged. Defects discovered during review are recorded
separately rather than folded into cleanup.

## Acceptance

- Apply the Java and TypeScript standards in CONTRIBUTING.md to production and tests.
- Review long files and complex branches for mixed responsibilities; extract only
  cohesive responsibilities with a simpler reading path.
- Keep reconciliation and persistence in ZooGlass. Workbench owns scenario inputs,
  faults, scheduling, execution and observable result checking; its tests must
  exercise those mechanisms independently of service correctness tests.
- Add independent assertions for uncovered boundaries and failure paths before
  moving the affected code. Preserve deterministic cleanup and bounded waits.
- Keep source maps current when dependencies change.
- Run Java verification, TypeScript lint/format/type checks, standard and browser
  coverage, build and relevant lifecycle checks. Record actual results and limits.

## Review sequence

1. Inventory source/test files, dependencies, complexity and existing verification.
2. Establish baseline checks and inspect uncovered behaviour.
3. Improve formatting/control flow separately from responsibility extractions.
4. Add missing Workbench/component coverage and make protected extractions.
5. Review the complete diff and run the final validation matrix.

## Review findings and decisions

The inventory covers 164 Java source/test files and 172 TypeScript/JavaScript
source, test and tooling files, together with repository configuration and source
maps. Syntax scans located unbraced control flow, wildcard imports, long methods
and deep branches; dependency inspection found no TypeScript runtime import cycles.
Shared Workbench execution, browser, control, scenario and service modules remain
independent of concrete demo modules.

Java formatting uses google-java-format 1.35.0 with `--aosp` (four-space indentation);
TypeScript uses the existing Prettier configuration. Java imports are explicit,
conditional/loop bodies have braces, and ESLint now enforces braces in TypeScript.
These mechanical changes are isolated in commit `28e368c`. No formatter dependency
was added to the application or build.

The structural changes follow existing ownership:

- `ConfigurationValidation` checks cross-field configuration references and
  compatible strategies; `V2Configuration` retains decoding and value definitions.
- `RecoveryValidation` orchestrates recovery and stream validation. `TargetRecovery`
  owns retained outcomes and `ViewRecovery` owns candidates and exposed views.
  Value and age checks keep inner candidate loops shallow. These are stateless,
  package-private helpers, with no reverse dependency on the orchestrator.
- Timeline fault parsing has a named validation helper, preserving rejection order
  and optional-field shape. Child/run captures replace unnecessary non-null
  assertions; WebSocket relay data uses the transport's actual input type.
- Continuous vehicle delivery uses early returns for offline and quiet periods.
  One owner still controls source sockets, delayed messages and cancellation.

Larger controller/client factory functions remain cohesive owners of their state
and cancellation. Splitting them into additional objects would spread lifecycle
invariants across files. Similarly, transactional staging and row restoration
remain sequential, cohesive methods; their size alone did not justify extraction.
Several reported nesting hotspots were ordinary `else if` dispatch chains, not
nested decisions. Comments explain ownership, validation preconditions and failure
behaviour rather than narrating each statement.

## Behaviour and verification evidence

The clean baseline at `b79b5b1` passes 313 Java tests. Comparing disassembled code
for all 142 existing production classes after refactoring finds changed instruction
listings only in `V2Configuration` and `RecoveryValidation`, whose validation was
extracted. Constant-pool indices are normalised for this comparison. A separate
TypeScript syntax comparison isolates the intentional parser, owner capture,
producer and lint changes from formatting and type-only edits. These comparisons
supplement tests; they do not prove semantic equivalence of the extracted logic.

New tests use explicit independent expectations: SQLite numeric boundaries and
corrected publication identities in Java; step planning, fault grammar, view
grammar, namespacing and real producer sockets in Workbench. Producer delivery was
tested before and after the extraction. Reconciliation and persistence assertions
remain in Java; Workbench tests exercise harness mechanisms and public interfaces.

The refactored Java suite passes 325 tests, including 12 new numeric boundary
cases. Local lint, formatting, type checking, builds and CI selection tests pass.
The standard Workbench run passes 176 tests; the two additional producer tests
pass on the final producer implementation. The complete final suite includes all
178 tests. Browser coverage, lifecycle and engine checks are part of the full
[PR #135 validation matrix](https://github.com/sproates/zooglass/pull/135/checks),
which is the source of truth for the latest revision's result and report artefacts.

On this constrained workspace, standard and browser test files run with
`--test-concurrency=2`; Java verification runs separately. Initial overlapping
builds and overloaded service starts were discarded, not counted as passing
baselines. The clean Java baseline uses a separate detached checkout. Coverage
reports locate unexercised paths; neither percentages nor this review establish
exhaustive correctness or eliminate the need for future code review.
