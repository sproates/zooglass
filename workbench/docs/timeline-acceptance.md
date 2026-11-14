# Bounded timeline acceptance candidate

The POC implements the bounded deterministic timeline described in the
[capability guide](timeline-guide.md) and [completion contract](timeline-completion.md).
Engineering checks are complete and the candidate is ready for an owner acceptance
decision. Promotion to main remains a separate decision.

## Supported guarantee

For an admitted scenario, exact configuration, seed, artifact set and recorded
environment, virtual time and causal ordering determine the semantic trace.
The host runs the real production runtime and strategies. Replay executes fresh
processes and compares their emitted records; it never substitutes saved outputs.
Host delays must not change semantic outcomes within the supported profiles.

That guarantee covers the bounded memory and SQLite lifecycle profiles and the
representative Fleet, Order and Sports configurations listed in the guide. It does
not cover arbitrary legacy configurations, native concurrent interleavings, physical
mid-commit crashes, real network timing or equal traces across different environments.
Sports restart, variable latency, directional stalls and broader fault selectors
remain outside the accepted first-release scope. Ordinary socket/browser tests
retain their separate role.

## Combined evidence

The [retained manifest](../evidence/README.md) pins seven qualification archives.
The aggregate audit checks all archive hashes and inventories: 2,201 payload files and
285,494,992 uncompressed payload bytes. It checks 1,961 raw campaign run hashes covering
166,229 trace records, 32 exact-trace groups, 79 historical tooling-file hashes
against Git and 55 prior independent-audit file references. Historical evidence
remains bound to its tested source and artifacts; it is not relabelled as a new
campaign at the final candidate.

| Requirement                        | Evidence                                                                                              |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Virtual time and ordered execution | Memory/document campaigns and deliberate real-clock leak control                                      |
| Freshness and lifecycle continuity | Memory and SQLite restart campaigns; incorrect generation-clock controls                              |
| Real strategy execution            | Production class identity checks and actual incorrect Fleet/Order/Sports runtime controls             |
| Representative outcomes            | Independently authored Fleet, Order and Sports expectations and scoped ordinary-service parity        |
| Honest replay and comparison       | Fresh-process replay, complete evidence validation, strict outcomes and explicitly offline comparison |
| Production separation              | Simulation controls excluded from the service JAR; prepared host embeds the matching runtime          |

## Final checks

Candidate `9798fab` preserves runtime/executor sources from `d17e832`. Corrections
format one guide and two semantically unchanged SQLite documents, exclude generated
Sports fixtures from formatting to preserve qualified bytes, and fix a browser-test
helper for confirmed keyboard-triggered closure during reset. The regression fails
before the fix; all eight focused cases and the five-cycle reset test pass afterwards.
The helper still requires confirmed old-page closure and a distinct ready replacement.
A clean detached checkout installed dependencies and explicitly prepared artifacts;
tests then consumed those artifacts without building Java. The guide's admission,
bundle record, strict replay and comparison workflow verified 432 Fleet records at
`c7febe7`; the final test-helper correction does not change executor/artifact identity.

The complete branch diff selects all eight baseline check groups.
[Full CI at `9798fab`](https://github.com/sproates/zooglass/actions/runs/43648969480)
passes production Java, timeline/packaging, static/core/demo, browser-host, all three
browser engines, and native lifecycle/reconnect on macOS and Windows. This is
regression validation, not a new cross-platform deterministic campaign.

Local clean-checkout checks passed 514 production Java tests, 144 host tests,
289 timeline/packaging tests, 146 core tests, 54 demo tests, 18 CI-selection tests,
six archive-verifier tests and the prepared-service startup check. Static checks
and changed-document links pass. The reset correction additionally passed eight
focused cases and the five-cycle integration check. Initial parallel local browser checks
hit two deadlines under heavy process load; both passed unchanged in isolation.
No timeout was relaxed and no runtime change was made for those failures.

Clean-checkout preparation uses the documented toolchain and resolves dependencies;
it is not an offline dependency-bootstrap claim. Acceptance does not imply a merge
with current main or conversion of every existing Workbench feature.

The [acceptance evidence archive](../evidence/README.md) retains logs, clean-checkout
identities, CI results, the fresh bundle/replay/comparison and the reproducible
aggregate audit. That audit expects the seven earlier archives at their recorded
workspace paths and a matching Git history; it does not replay them or contain
their executable dependencies. Independent review found no outstanding issues.
