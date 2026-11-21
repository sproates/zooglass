# Publication explanation qualification

This is the final, bounded qualification for [publication explanations](timeline-explanations.md).
The implementation was delivered in [PR #194](https://github.com/sproates/zooglass/pull/194).
The fixed qualification passed on 21 November 2026 at
[`5ac16cc`](https://github.com/sproates/zooglass/commit/5ac16cc341df5839b6f5b6c49f73bec7980f4052).
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

## Recorded results

All **12 executions** completed: eight retained bundles and four fresh replay
results. Both normal/paused pairs have identical semantic traces. The audit checks
five in-turn JVM pauses and all 70 Node pauses across the two perturbed runs,
including initialization and ingress after restart. There are no timer alarms in
this static family, so no alarm-dispatch pause is claimed.

The deliberately faulty runtime still passes its scenario assertions. Exactly one
semantic record changes: the older-alias update says `LATEST_EQUAL` instead of
`LATEST_OLDER`. All non-decision records, including state, receipts and assertions,
remain identical after the header's artifact identity is excluded. The independent
reason oracle detects that error.

The eleven offline safety controls pass. An independent offline audit agrees
exactly with the retained result. The published archive was downloaded, its hash
and complete inventory verified, and its extracted evidence audited again with an
identical result. There were no aborted qualification attempts.

[Download the retained evidence](https://github.com/sproates/zooglass/releases/download/timeline-explanation-evidence-20261121/macos-arm64-timeline-explanations-20261121.tar.gz) or see the
[committed hash manifest](../evidence/README.md). The archive contains 73 files and
1,853,774 uncompressed bytes; prepared JARs and dependencies remain outside it.
Preparation used committed production source `80e777f`; its Java tree is identical
to the campaign revision. Only `LatestBySequence.class` and the nested runtime JAR
differ between the verified normal and mutant artifacts.

### Example: an older alias input

In the retained memory baseline, authored action `older-alias` is `event-55`.
Its receipt is `event-58` and decision is `event-59`:

| Field   | Recorded reason  | Retained changed | Public changed |
| ------- | ---------------- | ---------------- | -------------- |
| arrival | ARRIVAL_REPLACED | true             | true           |
| history | HISTORY_INSERTED | true             | true           |
| latest  | LATEST_OLDER     | false            | false          |

The same-value action's decision (`event-42`) records retained changes for arrival
and latest, but no public change. After memory restart, `event-87` links its
original detail to `event-83`, not the first lifetime's `event-25`, even though
publication identity and receipt version repeat. SQLite's corresponding retry
links back to the original durable application.

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
