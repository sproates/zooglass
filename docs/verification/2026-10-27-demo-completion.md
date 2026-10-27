# Vehicle demo completion record

This record is the proposed final acceptance of the bounded vehicle demo in
[PR #75](https://github.com/sproates/zooglass/pull/75). Merging that PR records
acceptance of the evidence and scope below and closes the delivery milestone.

A user can run the published commands, follow late delivery and recovery in a
real browser, and see the views returned by ZooGlass.

Reviewed baseline: `17216623f2cdc3f3cedd4e92344f5bc19ba672d4`, after
[PR #74](https://github.com/sproates/zooglass/pull/74). This is a reconciliation
of the merged acceptance evidence, with a final check of baseline CI and document
links. It adds no runtime behaviour and does not claim a new manual walkthrough.

## Acceptance evidence

| Requirement | Result and accepted evidence |
| --- | --- |
| Real browser views | The app subscribes to both ZooGlass views and renders received snapshots. Source sends remain separate from receipts. The [recovery review](2026-10-26-recovery.md), accepted in [PR #69](https://github.com/sproates/zooglass/pull/69), records service, receipt and independent rendering checks. |
| Late and duplicate delivery | Late 41 fills history while latest stays 42. Identical duplicate 41 adds no history entry, checked after a later processing barrier on the same source connection. The recovery review identifies the exact fixture and tests. |
| Deliberate reconnect | Both server views reach 43 while the viewer is disconnected. The first snapshot of each resubscribed view is checked before further source delivery. Retained browser data is labelled Last received. |
| Unexpected connection loss | The separate fault scenario breaks the actual data route, observes a refused retry and source progress, then restores only the route. Bounded client recovery obtains both initial snapshots. Deadline expiry, Reset and old-session isolation are covered in the recovery review. |
| Documented setup and controls | The [fresh-checkout walkthrough](2026-10-26-fresh-checkout.md), accepted in [PR #70](https://github.com/sproates/zooglass/pull/70), completed twenty journey checkpoints and eight each for deliberate recovery and connection loss through the real CLI. Play also reached position 59 with twenty history entries. |
| Cleanup and repeatability | The [cleanup review](2026-10-26-cleanup.md), accepted in [PR #71](https://github.com/sproates/zooglass/pull/71), checks quit, SIGINT and SIGTERM, reusable ports, removed configuration and fresh state after restart. Resource workloads cover repeated reconnects and Reset. |
| Keyboard and layout | The [usability review](2026-10-26-usability.md), accepted in [PR #72](https://github.com/sproates/zooglass/pull/72), covers keyboard controls, desktop/narrow layouts, enlarged text and waiting, empty, retained and failed states. Two text-layout defects were fixed. |
| Accurate explanation | The [claims review](2026-10-27-capabilities.md), accepted in [PR #73](https://github.com/sproates/zooglass/pull/73), distinguishes received history, sequence ordering, snapshot recovery and a schematic route from broader product intentions. |
| Lasting architecture guide | The [canonical vertical diagram and guide](../diagrams/README.md), accepted in [PR #74](https://github.com/sproates/zooglass/pull/74), remain linked from the project and Workbench guides. They explain the implemented test environment separately from intended production topology. |

## Final verification

All seven jobs passed on the reviewed main commit in
[Workbench CI run 40424318102](https://github.com/sproates/zooglass/actions/runs/40424318102):
standard tests/build, browser host, native lifecycle on macOS and Windows, and
focused Chromium, Firefox and WebKit probes. The engine probes are not the full
vehicle scenario suite on every browser.

The accepted recovery run recorded 136 standard tests, 45 browser tests and both
resource workloads passing. The subsequent usability change added a keyboard
check and recorded 46 browser tests passing, plus type, lint and formatting
checks. Since recovery acceptance, the only application change is three CSS
rules for enlarged-text layout; the remaining changes are documentation and
browser regression coverage. The later main CI above covers that final baseline.

This completion PR changes root documentation only. Application tests have not
been rerun locally for it, and the current workflow path filters do not trigger
Workbench CI for these files. An absence of triggered checks is not a
new passing run. Relative links and whitespace are checked for this record and
the updated README, roadmap and plan.

## What completion means

The delivered result is a finite, single-vehicle demonstration with a twenty-point
journey and focused recovery scenarios. Workbench owns real service, source and
browser lifecycles, and checks observable results. Vehicle rendering checks
remain optional demo behaviour; shared execution does not depend on the vehicle UI.

The evidence supports the agreed demo scope. It does not establish customer
value, production readiness or a general-purpose middle tier. In particular:

- State is in memory. Durable recovery, replay, retention policy, correction
  revisions and completeness/freshness contracts remain separate product work.
- Reconnect obtains independent current snapshots, not an atomic pair or every
  missed transition. Automatic retry is bounded, explicitly armed demo policy.
- The fault gate establishes recovery from an abrupt local data-route break,
  not arbitrary network faults or silent blackholes.
- The route is schematic. Multiple vehicles, a street map and external source
  integration are outside this completed scope.
- Application authorisation remains a [required, unimplemented capability](../requirements/authorisation.md).
- Setup was verified on macOS with existing dependencies and caches. Keyboard
  and layout checks are not a full accessibility audit or native mobile test.
- Tests still invoke Maven through the service launcher. Changing tests to launch
  prebuilt ZooGlass remains outstanding; accepting this demo does not resolve it.

The next product review should assess what these behaviours make useful, where
the product contracts are still missing, and what a more polished demo would
need to communicate. That review should determine the next delivery scope.
