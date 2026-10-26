# Vehicle demo keyboard and layout acceptance

The final usability check found two enlarged-text layout issues and fixes them
in the vehicle demo stylesheet. At 320 CSS pixels with root text enlarged to
200%, the current-position row forced the page to 383 pixels wide. The row now
wraps. Buttons could also extend beyond their control panel without overflowing
the page; they now stay within the available width and wrap long labels.

Reviewed baseline: `1f7f868fab49668cbb0cda9ac39421aff210dde4`. The changes are
limited to presentation and browser regression checks. ZooGlass behaviour,
Workbench execution and source-map dependencies are unchanged.

## Verification

Checked on macOS with Chromium, using real ZooGlass for the journey and keyboard
controls. Controlled protocol peers supplied independent waiting, explicit empty,
disconnected and connection-failure states. These peers exercise presentation;
they do not establish additional service behaviour.

| Area | Evidence |
| --- | --- |
| Desktop and narrow layout | The journey test checks 1280, 390 and 320 CSS-pixel widths with no horizontal page overflow. Screenshots were inspected alongside focused state captures at 1280 and 320 pixels. |
| Enlarged text | The journey test sets root text to 200% at 320 pixels. It checks both page reflow and every button's containment within the control area. The current-position layout now wraps rather than extending beyond the page. This is text enlargement, not a claim to have tested every browser zoom mode. |
| Step and Reset | The existing usability test uses Tab/Enter for Step, Shift+Tab/Space for Reset, checks empty replacement history and advances again. |
| Play/Pause and connection controls | The new keyboard-control test uses Tab navigation and Space/Enter for Play/Pause, Disconnect/Reconnect viewer and Interrupt/Restore data. It waits for asynchronous completion and confirms exploratory actions are recorded. It restores focus to each completed control before checking the next tab position. |
| Scrollable content | Existing tests check keyboard scrolling of received history and run activity. Both lists have accessible names and remain in the tab order. |
| Waiting and empty states | Each view distinguishes waiting for its first snapshot from an explicit empty history snapshot. A current position can appear while history is still waiting. |
| Disconnected and failed states | Retained coordinates remain visible and are labelled Last received, with disconnected or connection-failed text. Failure is expressed in words rather than colour alone. |
| Semantics | The document declares its language, uses native labelled buttons and named sections, exposes connection/run status and control-error roles, and provides textual coordinates and a description alongside the schematic SVG. |

Run from `incubator/workbench`:

- `npm run test:browser`: **46 passed**.
- `npm run typecheck`, `npm run lint` and `npm run format:check`: **passed**.

The new regression checks are in
[`keyboard-controls.test.ts`](../../incubator/workbench/test/browser/keyboard-controls.test.ts)
and the extended
[`usability.test.ts`](../../incubator/workbench/test/browser/usability.test.ts).
State distinctions remain covered by
[`states.test.ts`](../../incubator/workbench/test/browser/states.test.ts).

## Acceptance boundary

This review recommends accepting the demo's bounded keyboard and layout task.
It is not a full accessibility audit, screen-reader session, native mobile test
or assurance of compliance with an accessibility standard. The schematic's text
alternatives remain necessary at narrow sizes. Broader product UI design is not
part of the shared Workbench core.

Capability claims and the lasting architecture explanation still need their
final review before the programme completion record.
