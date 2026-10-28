# Interactive external-viewer acceptance

The interactive fleet demo is sufficiently checked for demonstrating ZooGlass
with multiple viewers. This record proposes acceptance of the existing viewer
features on `feature/vehicle-fleet`; acceptance is pending review and merge.
The complete programme still needs its final PR to main.

The audit reviewed the existing test assertions at `e3f3593`. The subsequent
continuous-demo marker-selection correction merged in
[PR #91](https://github.com/sproates/zooglass/pull/91) as `7720595`.
All seven PR checks passed in
[run 40746508393](https://github.com/sproates/zooglass/actions/runs/40746508393).
This documentation change reuses that evidence; it adds no test workload.

## What is covered

Test paths below are relative to `incubator/workbench/test`.

| Behaviour | Evidence |
| --- | --- |
| Pairing and refresh | `viewer-leases.test.ts` checks single-use invitations, expiry, valid refresh and rejected credentials/revoked leases. `browser/external-viewers.test.ts` refreshes an actual page without adding another viewer. |
| Controller authority | `browser/external-boundary.test.ts` rejects observer commands and queued commands whose authority changed during handover. It also checks Host/Origin and invitation reuse. |
| Handover and viewer loss | `browser/external-viewers.test.ts` transfers control, executes Step from the new controller, revokes the old viewer without disconnecting the other, and checks that controller loss pauses playback. |
| Independent viewers | The same browser test selects cars independently and interrupts one viewer's data route while the other stays connected. |
| Shared Reset | The browser test retains the page, replaces its data route and clears markers. `browser/external-reset.test.ts` covers Reset during setup. Boundary tests detach an unready observer without aborting another viewer or the host. |
| Recovery | The external-viewer test restores a targeted route and checks received state. Separately, `browser/fleet-recovery.test.ts` advances sources offline and verifies every fleet pair's snapshot after reconnect, with no later source events. |

No additional test work was identified as necessary for this demo scope. The
external-route and complete-fleet recovery tests are complementary evidence;
we do not claim every combination is exercised in one browser run.

## Scope of acceptance

These are demonstrations with synthetic data on a trusted private network.
Browser clients and focused automated checks are sufficient for the stated
behaviour. Manual phone sign-off, device suspension, memory-pressure testing,
Wi-Fi/cellular transitions and hardware performance qualification are outside
scope. The [continuous-demo walkthrough](2026-10-28-continuous-walkthrough.md)
records the separate six-car experience and visual evidence.

Demo pairing and controller roles do not implement product authorisation.
ZooGlass authorisation, durable recovery and general freshness contracts remain
separate requirements. Further browser-orchestration features are not part of
this acceptance.
