# ZooGlass roadmap and progress

Last reviewed: 27 October 2026.

ZooGlass is an early prototype for maintaining and delivering event-driven live
views. Our current focus is to make its behaviour visible in a real application,
including when information arrives late and a client's connection fails. The bounded
vehicle demo's completion record defines final acceptance through
[PR #75](https://github.com/sproates/zooglass/pull/75); a product stocktake follows
that PR's merge.

This page records delivered work, the next milestones and longer-term direction.
Completed items link to merged changes or working documentation. Planned items
are intended outcomes, not release dates or claims of existing capability. The
[product explanation](docs/what-is-zooglass.md) describes the broader ambition.

## Delivered

| Area | Available now | Evidence |
| --- | --- | --- |
| Live-view prototype | An in-memory service matches source events to entity-scoped view fields, exposes HTTP reads and delivers full snapshots to WebSocket subscribers. Reconnecting clients can resubscribe for current state. | [Prototype guide](incubator/zooglass/README.md) |
| Ordering scenarios | Latest-position and received-history views can respond differently to the same out-of-order events. Scenarios explore duplicates and the limits of sequence-based completeness assumptions. | [Workbench ordering support, PR #18](https://github.com/sproates/zooglass/pull/18), [sequence guarantees, PR #20](https://github.com/sproates/zooglass/pull/20) |
| Workbench sessions | The CLI executes real service, source and Node-client interactions. Shared sessions own startup, actions and cleanup, with bindings for Node and browser clients. | [PR #23](https://github.com/sproates/zooglass/pull/23) |
| Browser design | The vehicle demo's browser control, independent rendered checks and data-connection fault behaviour are designed. The browser implementation includes data-route interruption and bounded recovery; the final completion record defines acceptance of the bounded demo. | [Design, PR #22](https://github.com/sproates/zooglass/pull/22) |
| Project guides | Separate production-intent and testing diagrams explain ZooGlass's direction. The Workbench guide describes the CLI and delivered browser orchestration, with their verification boundaries. | [Project explanation, PR #24](https://github.com/sproates/zooglass/pull/24), [Workbench guide, PR #25](https://github.com/sproates/zooglass/pull/25) |

The service remains in memory. Durable recovery, replay of missed messages and
a production retention policy are not implemented. Passing the current scenarios
demonstrates their specific cases, not production readiness.

## Delivered: a working browser view

The [basic vehicle app](incubator/vehicle-tracker/README.md) now receives actual
ZooGlass views under Workbench control. The default journey connects and
subscribes its browser, then sends twenty positions (40–59), with 41 delayed
until after 42. The short 40/42 fixture remains available with `--basic`. Service and browser
receipt checks pass, and Chromium tests inspect the rendered coordinates,
marker and history. The local command now starts ready for Step, with Reset
creating a fresh service and browser. Play/Pause continue the same cursor and
freeze the remaining delay while paused. `--auto` retains its single-run playback.

Waiting, explicit empty snapshots and retained/error states are visible. A
failed visible run stops and keeps its page available for inspection.
Step/reset, repeat-run lifecycle tests and the installation/usability walkthrough
are complete, including keyboard controls, history scrolling and narrow layouts
([PR #35](https://github.com/sproates/zooglass/pull/35)). Recovery implementation is accepted; the
[completion record](docs/verification/2026-10-27-demo-completion.md) covers final
acceptance of the complete demo.
Independent rendered checks now gate interactive and automatic completion,
including rejection of broken rendering despite correct socket receipts. See the
[fixture guide](docs/plans/vehicle-tracker-demo.md#basic-scenario-fixture).

The delivered browser-view milestone includes a fresh run, reset and another
checked run. See the [vehicle demo plan](docs/plans/vehicle-tracker-demo.md) for
the design and final acceptance criteria.

## Verification and readability review

Before extending the demo, we strengthened evidence for event ordering, reconnect
races, concurrent clients, invalid traffic and sustained activity. The
[verification map](docs/testing.md) records the current tests and measurement
boundaries. Seeded
ordering tests now compare every delivery prefix with an independent reference
model, including duplicates and source/entity isolation. Deterministic reconnect and lifecycle checks now cover stale callbacks, independent
snapshots and reset/close boundaries. Concurrent clients now have real-transport isolation and bounded slow-receiver
checks, alongside exact queue-limit tests. Invalid protocol and partial-failure tests now verify rejection, continued service
processing and fresh-session recovery. Bounded reconnect/reset workloads and queue/writer cleanup checks now cover
resource ownership, with history-size and heap observations recorded separately.
Native macOS/Windows lifecycle jobs and Chromium/Firefox/WebKit recovery probes now
make the checked platform scope explicit. The [verification review](docs/verification/2026-10-25.md) now records fresh-checkout
results, coverage comparisons and deliberate regression checks. Verification acceptance is merged in [PR #46](https://github.com/sproates/zooglass/pull/46).
The [responsibility review and extraction plan](docs/plans/readability-refactor.md)
was accepted in [PR #47](https://github.com/sproates/zooglass/pull/47), including
explicit separation of Workbench and demo code. The first service projection
extraction separates validation and field policies from state ownership; it is
merged in [PR #48](https://github.com/sproates/zooglass/pull/48). The delivery
extraction separates subscription indexing and per-client writer ownership while
preserving coordinator locking and queue order; it merged in
[PR #49](https://github.com/sproates/zooglass/pull/49). Scenario parsing has
separate model, view and timeline modules, merged in
[PR #50](https://github.com/sproates/zooglass/pull/50). HTTP view operations and
step planning merged in [PR #51](https://github.com/sproates/zooglass/pull/51),
while sessions and the controller retain resource and lifecycle ownership.
Host/session composition takes explicit assets and client identity, merged in
[PR #52](https://github.com/sproates/zooglass/pull/52). The shared control bridge
has a separate vehicle UI bootstrap, merged in
[PR #53](https://github.com/sproates/zooglass/pull/53); the inventory fixture uses
that same bridge. Client protocol/presentation separation merged in
[PR #54](https://github.com/sproates/zooglass/pull/54): socket state stays in a protocol module, with vehicle rules and
rendering supplied by a small binding. Shared demo assembly merged in [PR #55](https://github.com/sproates/zooglass/pull/55).
The independent core verification command and dependency/reuse review merged in
[PR #56](https://github.com/sproates/zooglass/pull/56). Core checks run without building the vehicle
UI or installing browsers; the full test suite remains available. Test organisation
merged in [PR #57](https://github.com/sproates/zooglass/pull/57), separating controller
behaviours and session/process ownership. CI turnaround improvements merged in
[PR #58](https://github.com/sproates/zooglass/pull/58). The
[final refactor review](docs/verification/2026-10-26-refactor.md) records fresh-checkout
results, dependency boundaries, justified larger modules and remaining risks.

The planned refactor is delivered in focused increments with behavioural
verification retained. The final review is the acceptance record; it does not
declare the prototype production-ready or close the remaining demo programme.
Further delivery decisions follow project review.

The vehicle demo also provides bounded run activity and current/next-step
explanations, distinguishing source sends from actual browser receipts. See the
[vehicle guide](incubator/vehicle-tracker/README.md#follow-the-run).

## Late delivery and recovery: accepted

The journey already shows delayed position 41 filling history without moving
the current marker back from 42. A separate recovery fixture checks duplicate
delivery after a processing barrier, then sends 43 while the viewer is
disconnected and verifies current snapshots after explicit reconnection.
It runs through both Node and browser clients. The interactive `--recovery` demo now runs this sequence with rendered checks
and separate connection checkpoints. Manual viewer controls leave the source
running and mark the run exploratory until Reset; client checks skipped during
exploration are explicitly counted. The host data-fault gate interrupts
active/pending data routes and refuses upgrades until restored. The client has
bounded retries and completes recovery only after all desired snapshots arrive.

The `--fault` real-service scenario is merged in [PR #68](https://github.com/sproates/zooglass/pull/68).
It waits for a refused retry, checks both server views advance while the browser
is cut off, then restores the route without issuing a reconnect command. Checks
verify the first recovery snapshots and rendered result. Node-only execution
rejects this browser fixture before service launch. Reset during an outage and
deadline expiry while paused also have real-service browser coverage. The
[acceptance record](docs/verification/2026-10-26-recovery.md) brings together the
evidence; this increment was accepted in [PR #69](https://github.com/sproates/zooglass/pull/69).

The [browser orchestration design](docs/plans/browser-orchestration.md) defines
the boundaries and checks. Final demo acceptance brings together a fresh-checkout walkthrough,
process cleanup, keyboard and narrow-screen checks, and documentation that
matches the demonstrated behaviour. The
[fresh-checkout walkthrough](docs/verification/2026-10-26-fresh-checkout.md)
passed setup and the journey/recovery scenarios and was accepted in
[PR #70](https://github.com/sproates/zooglass/pull/70). The
[cleanup review](docs/verification/2026-10-26-cleanup.md) verifies normal exit,
signal interruption, resource release and fresh state after restart, accepted in
[PR #71](https://github.com/sproates/zooglass/pull/71). The
[keyboard and layout review](docs/verification/2026-10-26-usability.md) adds
enlarged-text fixes and keyboard coverage, accepted in
[PR #72](https://github.com/sproates/zooglass/pull/72). The
[capability-claims review](docs/verification/2026-10-27-capabilities.md) records
what the demo establishes and corrects stale descriptions, accepted in
[PR #73](https://github.com/sproates/zooglass/pull/73). The maintained
[architecture diagram guide](docs/diagrams/README.md) preserves the vertical
stack and explains the implemented test environment, accepted in
[PR #74](https://github.com/sproates/zooglass/pull/74).

The [completion record](docs/verification/2026-10-27-demo-completion.md) reconciles
these accepted reviews and passing final-baseline CI. Merging
[PR #75](https://github.com/sproates/zooglass/pull/75) records final acceptance and
closes the bounded demo milestone. The next step after acceptance is a
product stocktake: assess demonstrated value, missing contracts and the scope
of a more polished demo, including multiple vehicles and a real map. This does
not commit to a particular implementation or delivery date.

## Longer-term direction

After the browser work, the product still needs decisions and evidence around:

- Source relationships, event identity and correction revisions.
- Freshness, provenance and source progress, including when completeness can be
  established. The [source progress exploration](incubator/zooglass/source-progress-signals.md)
  records options without selecting a policy.
- Durable state, retention and recovery contracts, including when replay is
  needed rather than a fresh snapshot.
- Integration with independently operated sources.

These are areas to develop, not a committed delivery sequence. Each needs a
specific contract and a way to test it before we can describe it as supported.

## Required: authorisation over time

ZooGlass must enforce permissions on snapshots, live subscriptions and recovery,
and stop active delivery within a specified bound when access is revoked or
expires. Resource and tenant boundaries must hold throughout those paths.
Reconnecting must not bypass a permission change.

This is a product requirement, with design and implementation still outstanding.
The [authorisation requirement](docs/requirements/authorisation.md) sets out the
expected behaviour, acceptance scenarios and decisions needed before delivery.
Workbench must verify access loss while real updates continue, as well as
allowed access and denied requests. This work has no delivery date or committed
position in the sequence yet. The planned verification and readability work is
complete; this requirement remains outstanding.

## Follow the work

[Pull requests](https://github.com/sproates/zooglass/pulls) show proposed and
reviewed changes; [merged pull requests](https://github.com/sproates/zooglass/pulls?q=is%3Apr+is%3Amerged)
provide the delivery record. [CI runs](https://github.com/sproates/zooglass/actions)
show the results of the automated checks.

Update this page when a milestone lands or the delivery direction changes,
keeping the current status and evidence together.
