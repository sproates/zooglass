# Prototype delivery retrospective

Recorded 30 October 2026. This preserves the delivery summary and evidence
boundaries previously presented in the roadmap. It describes the prototype at
this point in time; later work may extend these capabilities.

See the [roadmap](../../ROADMAP.md) for upcoming work.

## Delivered

| Area | Available now | Evidence |
| --- | --- | --- |
| Live-view service | In-memory, entity-scoped views combine matching source contributions. Field policies support arrival replacement, latest by sequence and received history by sequence. HTTP reads and WebSocket subscriptions deliver full snapshots. | [Prototype guide](../../zooglass/README.md) |
| Continuous Gibraltar demo | Six cars move automatically on a real map while source delivery introduces delayed, permanently lost and duplicate events, disconnects and reporting silence. The viewer shows latest-known positions and report-age labels. | [Run the demo](../../workbench/docs/continuous-driving.md), [walkthrough](../../docs/verification/2026-10-28-continuous-walkthrough.md), [PR #93](https://github.com/sproates/zooglass/pull/93) |
| Interactive vehicle demo | A separate three-car scenario provides Step/Play controls, selection, received history, independent position/status contributions and connection-fault exploration. External viewers have independent selection and a shared controller. | [Vehicle guide](../../vehicle-tracker/README.md), [external-viewer guide](../../workbench/docs/external-viewers.md), [acceptance record](../../docs/verification/2026-10-28-external-viewers.md) |
| Workbench Scenario Simulator | Repeatable scenarios drive real sources, ZooGlass and clients, with independent expectations, fault injection and owned process cleanup. Shared verification is separated from demo presentation. | [Workbench guide](../../workbench/README.md), [testing guide](../../docs/testing.md) |
| Verification and readability | Ordering, recovery, concurrent clients, invalid traffic and resource lifecycle checks are in place. Production and test responsibilities were separated, with maintained source maps. Tests launch an explicitly prepared application JAR rather than building during session startup. | [Verification review](../../docs/verification/2026-10-25.md), [refactor acceptance](../../docs/verification/2026-10-26-refactor.md), [launch contract](../../docs/testing.md#prebuilt-service-launch-boundary) |
| Developer-value comparison | A documented comparison with an equally scoped custom service identifies the responsibilities ZooGlass removes, concrete application changes and remaining costs. | [Comparison](../../docs/developer-value.md), [PR #94](https://github.com/sproates/zooglass/pull/94) |

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

