# ZooGlass roadmap and progress

Last reviewed: 28 October 2026.

ZooGlass is an early prototype for maintaining and delivering event-driven live
views. The vehicle-demo programme is complete and delivered to `main`, including
the continuous six-car Gibraltar demo and the separate interactive demo.
The next planned demonstrations are order tracking followed by live sports.

This page summarises delivered capabilities and outstanding product work. The
[product explanation](docs/what-is-zooglass.md) describes the broader ambition;
the [developer-value comparison](docs/developer-value.md) explains which
application responsibilities the current prototype handles and which remain
with the application.

## Delivered

| Area | Available now | Evidence |
| --- | --- | --- |
| Live-view service | In-memory, entity-scoped views combine matching source contributions. Field policies support arrival replacement, latest by sequence and received history by sequence. HTTP reads and WebSocket subscriptions deliver full snapshots. | [Prototype guide](zooglass/README.md) |
| Continuous Gibraltar demo | Six cars move automatically on a real map while source delivery introduces delayed, permanently lost and duplicate events, disconnects and reporting silence. The viewer shows latest-known positions and report-age labels. | [Run the demo](workbench/docs/continuous-driving.md), [walkthrough](docs/verification/2026-10-28-continuous-walkthrough.md), [PR #93](https://github.com/sproates/zooglass/pull/93) |
| Interactive vehicle demo | A separate three-car scenario provides Step/Play controls, selection, received history, independent position/status contributions and connection-fault exploration. External viewers have independent selection and a shared controller. | [Vehicle guide](vehicle-tracker/README.md), [external-viewer guide](workbench/docs/external-viewers.md), [acceptance record](docs/verification/2026-10-28-external-viewers.md) |
| Workbench Scenario Simulator | Repeatable scenarios drive real sources, ZooGlass and clients, with independent expectations, fault injection and owned process cleanup. Shared verification is separated from demo presentation. | [Workbench guide](workbench/README.md), [testing guide](docs/testing.md) |
| Verification and readability | Ordering, recovery, concurrent clients, invalid traffic and resource lifecycle checks are in place. Production and test responsibilities were separated, with maintained source maps. Tests launch an explicitly prepared application JAR rather than building during session startup. | [Verification review](docs/verification/2026-10-25.md), [refactor acceptance](docs/verification/2026-10-26-refactor.md), [launch contract](docs/testing.md#prebuilt-service-launch-boundary) |
| Developer-value comparison | A documented comparison with an equally scoped custom service identifies the responsibilities ZooGlass removes, concrete application changes and remaining costs. | [Comparison](docs/developer-value.md), [PR #94](https://github.com/sproates/zooglass/pull/94) |

The original bounded vehicle demo was accepted in
[PR #75](https://github.com/sproates/zooglass/pull/75). The subsequent fleet and
continuous-demo programme was delivered in
[PR #93](https://github.com/sproates/zooglass/pull/93). Their design documents and
verification records retain the detailed delivery history.

## What the evidence establishes

The continuous demo demonstrates the configured sequence policy: a delayed older
position does not replace a newer one. Received history is not proof of complete
history. A permanently lost report remains missing, and report age does not prove
that a source is current.

Reconnecting clients can obtain current snapshots. The service does not replay
every missed message, persist state across restarts or provide a production
retention policy. These remain product gaps.

Interactive external-viewer acceptance covers the recorded desktop Chromium
multi-viewer flow over loopback. Interactive phone/Safari and cross-device LAN
validation remain deferred and unscheduled. Physical-device suspension, memory
pressure, network transitions and hardware qualification are outside demo
acceptance. The continuous viewer has separate verification evidence in its
walkthrough.

## Next: order tracking, then live sports

The [proposed design](docs/plans/order-and-sports-demos.md) sets out two multi-source demonstrations, each with interactive Workbench controls and
a continuous infinite mode. Order tracking combines order, payment and inventory
facts; sports combines match and bookmaker publications. Each must show the
projection, ordering and subscription work ZooGlass removes, alongside the work
that remains in the application. Browser implementation has not begun.

Deliver order tracking before sports, with bounded source/view, browser and
acceptance slices. Authorisation remains required but is not the next delivery
item. The continuous modes keep controls out of the viewer experience; interactive
modes reuse existing Workbench controls without expanding browser orchestration.

## Required: authorisation over time

ZooGlass must enforce permissions on snapshots, live subscriptions and recovery,
and stop active delivery within a specified bound when access is revoked or
expires. Resource and tenant boundaries must hold throughout those paths.
Reconnecting must not bypass a permission change.

The [authorisation requirement](docs/requirements/authorisation.md) is published.
Its enforcement contract, implementation and acceptance remain outstanding.
The two planned demos come first; authorisation has no delivery date. Design needs to settle
identity and policy integration, revocation bounds, queued and in-flight data,
and behaviour when policy decisions are unavailable.

## Further product work

These areas need concrete contracts and evidence before they can become supported
capabilities. They are not a committed delivery sequence.

- **Freshness, provenance and source progress:** define what clients can infer
  about source activity and completeness. The
  [source-progress exploration](zooglass/source-progress-signals.md)
  records options without selecting a policy.
- **Durability, retention and recovery:** define persistence, bounded history and
  recovery after restart, including when replay is needed rather than a snapshot.
- **Source relationships, event identity and correction revisions:** define how
  independent sequence domains and corrections should affect projected state.
- **Independent source integrations:** establish behaviour with sources operated
  outside the simulated environment.

## Follow the work

[Pull requests](https://github.com/sproates/zooglass/pulls) show proposed changes;
[merged pull requests](https://github.com/sproates/zooglass/pulls?q=is%3Apr+is%3Amerged)
provide the delivery record. [CI runs](https://github.com/sproates/zooglass/actions)
show automated check results. The [architecture guide](docs/diagrams/README.md)
and component source maps explain the implemented structure.
