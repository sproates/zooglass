# Vehicle demo fresh-checkout walkthrough

The documented setup and vehicle scenarios work from a fresh checkout of
`fd9a713a292410400601cbd02e885113fe91cbee`. This review verifies installation and
scenario completion. It does not close the remaining whole-demo acceptance
checks for process ownership, usability, capability claims and the architecture
diagram.

## Environment and setup

Verified on macOS on 26 October 2026, with Node 26.0.0, npm, Git and JDK
25.0.5.0.2 already installed. The checkout was cloned from the public repository
into a new temporary directory. Before the first launch it had no ZooGlass
`target/`, Workbench `dist/` or vehicle-client `dist/` output.

Followed the [vehicle setup guide](../../demos/vehicle-tracker/README.md#run-it):

```sh
git clone https://github.com/sproates/zooglass.git
cd zooglass/workbench
npm ci
npx playwright install chromium
npm run demo -- vehicle-tracker --headless
```

`npm ci` installed 148 packages and reported no vulnerabilities in that run.
The Chromium installation command succeeded. Existing Maven and Playwright
caches were available on the machine; this is fresh-checkout evidence, not a
first installation on an unprepared machine or a verification of every download.

The documented headless option uses the same real browser and rendered checks,
with terminal controls instead of a visible browser window. Startup compiled
the vehicle client, built and started ZooGlass, opened Chromium, registered the
browser and reached the ready state without any manual prebuild or file edits.
The Maven launch still compiles Java sources and test classes. Changing test
startup to use a prebuilt service remains separate work.

## Walkthrough results

All commands below ran from `workbench` in the new checkout. Terminal
`step` commands were sent one at a time, waiting for each checkpoint's completion
before continuing. A temporary driver automated typing and collecting output;
it did not import application modules, send events or supply expected views.

| Run | Result |
| --- | --- |
| Default journey, `npm run demo -- vehicle-tracker --headless` | All twenty Step checkpoints completed and reported `All steps checked`. Final position 59 and twenty history entries. A separate Play run also reached those server values. |
| Deliberate recovery, adding `--recovery` | All eight checkpoints completed: 40, 42, late 41, duplicate 41, processing barrier, viewer disconnect, 43 while disconnected, then reconnect. The six conceptual demonstration steps include separate barrier and connection checkpoints. |
| Unexpected connection loss, adding `--fault` | All eight checkpoints completed, including a refused retry, source progress while the gate was closed, and automatic recovery after route restoration. No manual reconnect command was entered. |
| Exit | Each stepped run accepted `quit` and exited with status 0. The default Play run also exited successfully on `quit`. |
| Checkout state | No tracked files were changed by installation or the walkthrough. |

Completion includes the existing HTTP, browser receipt and independent rendered
checks; it is not inferred from successful source sends. The
[recovery acceptance record](2026-10-26-recovery.md) explains the first-snapshot,
duplicate-barrier and failure evidence behind those checks.

## Outcome

No setup fix was required. The fresh-checkout walkthrough is ready for acceptance.
This run used terminal controls and headless Chromium, so it does not claim a new
manual visual review, keyboard accessibility audit, native mobile test or
fresh-machine Windows/Linux installation. Successful exit is useful evidence,
but the final process-cleanup review still needs to reconcile ownership and
restart checks rather than relying on exit status alone.
