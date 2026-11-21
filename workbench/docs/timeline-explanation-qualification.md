# Publication explanation qualification

This is the final, bounded qualification for [publication explanations](timeline-explanations.md).
The implementation is delivered; qualification results are pending execution.
No simulation family is expanded by this work.

## Fixed matrix

The matrix is frozen before execution. Preparation, report generation and offline
audits are separate from the **12 scenario executions**.

| Case                                | Executions | Independent witness                                                                                                                                          |
| ----------------------------------- | ---------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Memory mixed strategies and aliases |          4 | Baseline, 70ms JVM/Node pauses, strict replay of both; older alias input, retained/public change distinction, memory restart and duplicate lineage           |
| SQLite restart and duplicate        |          4 | Same execution modes; original decision linked across durable restart                                                                                        |
| Staged rejection                    |          1 | `historyLimit` discards earlier candidates; no installed decision changes                                                                                    |
| Assertion failure                   |          1 | Deliberately wrong expected value remains a readable failed run                                                                                              |
| Older evidence                      |          1 | V4 receives observed outcomes without invented detailed reasons                                                                                              |
| Wrong production reason             |          1 | Actual runtime reports `LATEST_EQUAL` instead of `LATEST_OLDER`; independent oracle rejects it while values, receipts and scenario assertions stay unchanged |

Fixtures live in `scenarios/timeline-explanations/`. Literal expected reasons and
flags are keyed by authored action IDs. The checker independently locates source
attempts, receipts and decision events, then checks report references against them.
Memory restart deliberately reuses the same publication identity and receipt
version; its duplicate must link to the new lifetime, not the earlier application.

The reason control uses an isolated copy of the committed production sources. It
changes exactly one reason constant in the real `LatestBySequence` branch. Artifact
inventory checks permit only that implementation class and its containing runtime
JAR to change, apart from Maven metadata. No mutant is installed into the normal
checkout. The control is detected by its reason, not by a failed value assertion.

## Reproduce

Prepare artifacts explicitly before running any checks. Tests never initiate builds.
From `workbench/`, choose new directories outside the repository:

```sh
python3 scripts/prepare-explanation-mutation.py /tmp/explanation-prepared
node --import tsx scripts/explanation-campaign.ts /tmp/explanation-evidence /tmp/explanation-prepared
node --import tsx scripts/explanation-audit.ts /tmp/explanation-evidence /tmp/explanation-evidence/audit.json
```

The campaign requires clean committed sources. It retains complete bundles,
text/JSON reports, replay results, preparation provenance, artifact inventories and
the negative-control result. The audit performs no Java execution or network access.
It verifies retained hashes, independent expected outcomes and reasons, replayed
traces, pause evidence and report bytes. Eleven offline safety checks exercise
corrupted hashes, recomputed missing/duplicate decisions, output containment and
symlink aliases, exclusive creation, unknown events, bounds and terminal escaping.

## Scope

This qualifies the existing static arrival/latest/history explanation family on the
recorded machine and environment. It does not establish identical traces across
platforms or explain priority, required contributions, facts, timers or internal
recovery steps. Hashes establish consistency, not authenticity. Matching retained
executable/environment identities are still required for fresh replay.
