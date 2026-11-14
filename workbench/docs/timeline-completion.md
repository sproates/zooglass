# Deterministic timeline completion contract

Accepted completion boundary, 14 November 2026. This contract distinguishes the
working POC from the remaining requirements for its first bounded release. It
refines the [original design](../../docs/design/deterministic-timeline.md); it does
not claim that the whole design or every Workbench configuration is implemented.

## Supported promise and evidence

For an admitted scenario, configuration, seed, artifact set and recorded execution
environment, virtual time and causal ordering determine the semantic trace.
Replay executes the real runtime again and compares freshly emitted records.
Host delays must not change supported semantic outcomes. This is not a promise
of equal traces across environments, deterministic native thread races or real
network timing.

| Requirement                                         | Delivered evidence                                                                                                                                                            | Remaining completion work                                                                                                                                |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Controlled time, ordering and real runtime delivery | [Proof](timeline-proof.md), [document campaign](timeline-campaign-results.md), [clock-leak control](timeline-clock-leak.md)                                                   | Preserve these guarantees when adding Sports; no new scheduler design.                                                                                   |
| Bounded faults, retries and exact replay            | [Receipt loss](timeline-faults.md), [retries](timeline-retries.md), [FIFO links](timeline-links.md), [replay](timeline-replay.md), [portable evidence](timeline-artifacts.md) | CLI completion and final aggregate checks; fault boundary below is frozen.                                                                               |
| Memory and SQLite lifecycle                         | [Memory qualification](timeline-memory-qualification.md), [SQLite qualification](timeline-sqlite-qualification.md), [wall-clock behaviour](timeline-wall-clock.md)            | Preserve generation ownership and explicit profile restrictions. No arbitrary mid-commit crashes.                                                        |
| Fleet representative behaviour                      | [Fleet qualification and parity](timeline-fleet-qualification.md)                                                                                                             | Included in final regression acceptance.                                                                                                                 |
| Order representative behaviour                      | [Ordinary scenario](timeline-order-scenario.md), [recovery](timeline-order-recovery.md), [retention](timeline-order-retention.md)                                             | [Qualification](timeline-order-qualification.md) complete; preserve it in final regression acceptance.                                                   |
| Sports representative behaviour                     | [Assessed scope](timeline-order-sports-assessment.md); implementation outstanding                                                                                             | Explicit fact/retirement profile, complete acknowledgements, authored ordinary/retention cases, wrong-revision control, repeatability and scoped parity. |
| Usable command-line product                         | Run, inspect, replay and bundles already exist                                                                                                                                | Compare command, strict-default replay with explicit verification-only mode, integrated capability/environment matrix and fresh-setup guide.             |
| Final accepted guarantee                            | Prior bounded evidence remains valid within its recorded limits                                                                                                               | Freeze a candidate; complete-diff checks, combined evidence audit and clean-checkout setup; publish the exact supported guarantee after acceptance.      |

## Frozen fault boundary

The first bounded release includes declared presend ordering and omission, fixed
one-way FIFO latency, source receipt loss with exact retry, abortive connection
close/reconnect, viewer writer stall/release/failure, source silence and service
stop/start between completed turns. Fault selection uses the existing bounded
receipt-action rules; unsupported combinations fail admission.

Directional link stalls and interval-based fault selectors from the broader
original design are explicitly deferred. Variable link delays, arbitrary post-send
frame loss and broader partition modelling are not prerequisites. Writer handoff
stalling remains supported and is distinct from stalling one direction of a link.
No implied lossy WebSocket transport or graceful-close guarantee is introduced.

## Remaining delivery sequence

1. **Freeze this contract — complete.** Record evidence, remaining work and approved deferrals.
2. **Qualify Order — complete.** Declare the finite matrix before running it; audit and retain
   results once. No further Order capability expansion.
3. **Implement bounded Sports support.** Reuse real strategies and existing
   transport/ownership boundaries. No generic endpoint framework or inferred
   Sports restart support.
4. **Qualify Sports.** Cover corrections, withdrawals, absent versus zero values,
   retirement and retention, then close representative scenario coverage.
5. **Finish CLI and the capability guide.** Run/replay/inspect already exist; add
   compare and implement the accepted replay policy without another engine.
6. **Aggregate acceptance and handoff.** Fix demonstrated defects against the
   frozen contract and present the supported release for acceptance.

Stable replay will exit successfully only when re-execution verifies a passing
scenario. An explicit verification-only option will support reproducing failed
runs. This policy is accepted but not yet implemented: current commands still
require `--require-passed` for strict outcome checking.

## Completion discipline

Add work only for a demonstrated defect, an unmet frozen requirement or an
explicitly accepted scope change. Review corrections belong within their delivery
block. Use focused checks; do not repeat broad campaigns for documentation-only
changes or multiply seeds that exercise no new behaviour.

Full legacy conversion, a DSL, an interactive timeline UI, arbitrary configuration
support, protected transport, extensive Sports restart combinations and expanded
cross-platform qualification are separate follow-ups. Existing Linux evidence
retains its recorded scope; no cross-platform trace-equality claim follows.
Ordinary socket, browser, TLS, physical crash and concurrency tests keep their
separate roles. Promotion from the POC branch is a separate acceptance decision.
