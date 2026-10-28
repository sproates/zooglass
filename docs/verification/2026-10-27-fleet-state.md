# Three-vehicle fleet acceptance

This record proposes acceptance of the fleet state and selection increment on
`feature/vehicle-fleet`, following [PR #79](https://github.com/sproates/zooglass/pull/79)
and [PR #80](https://github.com/sproates/zooglass/pull/80). Acceptance remains
pending review and merge. It does not complete the geographic map or network
viewer increments, or deliver the programme to main.

Reviewed implementation: `5d31f190b6bb5fe6dd450f5ee612a8b156e627c7`.
This acceptance change adds two browser regression tests and documentation;
it changes no application behaviour or module responsibilities.

## Evidence

| Requirement | Evidence |
| --- | --- |
| Independent entities and source fields | The [contract fixture](../../workbench/docs/fleet-contracts.md) checks exact HTTP state and real socket receipts for three entities and two views. Location and operation use independent sequence domains. Later events on each source connection provide processing barriers before unchanged-state checks. |
| Late and duplicate delivery | Car-17 retains latest position 42 while late 41 fills its received history. Car-28 retains operation 102 after late 101. Duplicate and changed-payload repeats at an accepted sequence preserve the first payload. These are fixture assertions, not values injected into the UI. |
| Selection and subscription isolation | `test/browser/fleet.test.ts` runs the complete fixture with car-28 selected, then independently checks every vehicle's detail and history. Recorded data-socket sends show selection sends no subscription commands; reconnect sends six distinct subscriptions. |
| Receipts and rendering are separate | The optional fleet observer checks visible fleet rows and selected history after real receipt checks. Removing a position element deliberately makes verification fail despite correct receipts. Unselected histories are receipt-checked during playback, then selected and inspected by the browser test. |
| Waiting, empty and retained data | `test/demo-unit/fleet-model.test.ts` distinguishes absent snapshots from explicit empty history, rejects malformed snapshots without partial mutation, and retains values with per-pair recovery state. Browser checks cover initial waiting, retained disconnected data and fresh Reset. Empty-history distinction is model coverage, not a claim of a separate browser walkthrough. |
| Catch-up after offline progress | `test/browser/fleet-recovery.test.ts` disconnects after the first position, advances the remaining source events and HTTP checks, and verifies retained position 40. Reconnect then provides the final state and history for all six pairs without further source events. The run remains labelled exploratory, not a scripted pass. |
| Keyboard playback and selection | `test/browser/fleet-usability.test.ts` operates Play/Pause by keyboard, selects a vehicle through tab order and resumes Play to complete all checks. Focus stays on the selected vehicle as background updates arrive. Tab/Enter then selects another vehicle with its own history. Only fixture timing is slowed for this test; events and expectations are unchanged. |
| Responsive text presentation | The same test checks 1280px, 390px and 320px widths at 100% and 200% root font size, with no horizontal page overflow and controls contained in their panel. Desktop and narrow enlarged-text captures were visually inspected. At 320px with enlarged text, labels wrap substantially but remain available. This is not a native phone or accessibility audit. |

The existing [fleet screenshot](../../vehicle-tracker/docs/fleet-selection.png)
illustrates the text-based presentation. The usability test writes reproducible
captures under `workbench/test-results/fleet-*.png`.

## Verification and reproduction

From `workbench`, with dependencies installed and the current ZooGlass
executable JAR already prepared:

```sh
npm run test:browser
npm run typecheck
npm run lint
npm run format:check
npm run demo -- vehicle-tracker --fleet
```

Tests launch the prebuilt JAR; they do not invoke Maven. If Java sources change,
prepare the service explicitly with `npm run prepare:service` before testing.

Local acceptance checks passed: 144 standard tests, 50 browser tests, typecheck,
lint, formatting and whitespace. Relative documentation links were checked.
The browser suite includes the existing single-vehicle variants.

The baseline programme commit passed all seven jobs in
[Workbench CI run 40530807909](https://github.com/sproates/zooglass/actions/runs/40530807909).
That run precedes these two additional tests. The fleet browser checks use
Chromium; focused engine probes elsewhere do not establish full fleet coverage
on Firefox or WebKit.

## Boundaries

This establishes a bounded three-vehicle, two-source example with six explicit
subscriptions, independent received state and local selection. It does not
establish atomic snapshots across views, complete history, source freshness,
correction revisions, durable recovery, authorisation or production scale.
No claim is made about suppressing redundant server notifications.

The geographic map, six-vehicle longer scenario, simultaneous viewers and direct
phone access remain subsequent increments. The original single-vehicle variants
remain available. Workbench's shared execution stays independent of vehicle
rendering; the fleet observer is optional demo-specific verification.
