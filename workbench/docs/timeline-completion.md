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

| Requirement                                         | Delivered evidence                                                                                                                                                            | Remaining completion work                                                                                                                             |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Controlled time, ordering and real runtime delivery | [Proof](timeline-proof.md), [document campaign](timeline-campaign-results.md), [clock-leak control](timeline-clock-leak.md)                                                   | Preserve these guarantees in final aggregate acceptance.                                                                                              |
| Bounded faults, retries and exact replay            | [Receipt loss](timeline-faults.md), [retries](timeline-retries.md), [FIFO links](timeline-links.md), [replay](timeline-replay.md), [portable evidence](timeline-artifacts.md) | CLI completion and final aggregate checks; fault boundary below is frozen.                                                                            |
| Memory and SQLite lifecycle                         | [Memory qualification](timeline-memory-qualification.md), [SQLite qualification](timeline-sqlite-qualification.md), [wall-clock behaviour](timeline-wall-clock.md)            | Preserve generation ownership and explicit profile restrictions. No arbitrary mid-commit crashes.                                                     |
| Fleet representative behaviour                      | [Fleet qualification and parity](timeline-fleet-qualification.md)                                                                                                             | Included in final regression acceptance.                                                                                                              |
| Order representative behaviour                      | [Ordinary scenario](timeline-order-scenario.md), [recovery](timeline-order-recovery.md), [retention](timeline-order-retention.md)                                             | [Qualification](timeline-order-qualification.md) complete; preserve it in final regression acceptance.                                                |
| Sports representative behaviour                     | [Bounded support](timeline-sports-host.md), [Sports qualification](timeline-sports-qualification.md)                                                                          | Qualification complete; preserve it in final regression acceptance.                                                                                   |
| Usable command-line product                         | Run, inspect, replay and bundles already exist                                                                                                                                | [CLI and capability guide](timeline-guide.md), comparison and strict-default replay implemented; aggregate checks complete, owner acceptance pending. |
| Final accepted guarantee                            | Prior bounded evidence remains valid within its recorded limits                                                                                                               | [Candidate checks complete](timeline-acceptance.md); owner acceptance and main promotion remain pending.                                              |

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
3. **Implement bounded Sports support — complete.** Reuse real strategies and existing
   transport/ownership boundaries. No generic endpoint framework or inferred
   Sports restart support.
4. **Qualify Sports — complete.** Corrections, withdrawals, absent versus zero values,
   retirement, retention, wrong-policy control and service parity close representative
   scenario coverage.
5. **Finish CLI and the capability guide — complete.** Compare saved evidence,
   use strict-default replay and follow the integrated capability/setup guide.
6. **Aggregate acceptance and handoff — engineering checks complete.** The
   [acceptance candidate](timeline-acceptance.md) records full validation, combined
   evidence audit and clean-checkout setup. Owner acceptance and main promotion
   remain separate decisions.

Stable replay will exit successfully only when re-execution verifies a passing
scenario. An explicit verification-only option will support reproducing failed
runs. This policy is implemented; `--verification-only` explicitly permits reproduced
failures, and `--require-passed` remains a compatibility alias for the strict default.

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
