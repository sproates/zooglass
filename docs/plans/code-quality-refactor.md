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

Work is in progress. This document records scope, not a claim that every file has
already been reviewed or that validation has passed.
