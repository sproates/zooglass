# Vehicle demo capability claims

The demo's labels and documentation have been checked against implementation
`cf5b3bdef0ede513ded55e0d3053d8a9d30f16b1`. The UI already distinguishes
received history, retained data and a schematic route. This review corrects
stale descriptions of delivered features and makes the boundaries of “current”
and duplicate handling explicit in the viewer guide.

## What the demonstration establishes

| Topic | Supported claim | Boundary |
| --- | --- | --- |
| Latest position | `latestBySequence` keeps the highest accepted numeric sequence for the configured view/entity field. Late 41 does not replace 42. | Sequence is supplied by the source. This does not measure source freshness, prove the source is still active or locate a vehicle in real time. |
| Received history | `historyBySequence` orders accepted positions by sequence and suppresses repeated sequences. | `[40, 42]` is received history, not proof that 41 is missing or that the history is complete. There is no watermark/completeness contract. |
| Duplicates and corrections | The duplicate fixture proves identical 41 does not add an entry after a processing barrier. | Equal sequences with changed payloads do not revise existing entries. There is no general revision or correction model. The barrier relies on current same-source sequential processing, not global source ordering. |
| Reconnect | A new subscription receives current full snapshots. The demo verifies the first recovery snapshot of each desired view. | This is snapshot recovery, not delivery of every missed event or transition. The independent view snapshots are not atomic as a pair. |
| Automatic retry | The vehicle client retries after an expected, explicitly armed data interruption, within its bounded deadline. | This is demo client policy, not a server guarantee or a universal reconnect mechanism. An unarmed unexpected loss fails the run. Silent blackholes and arbitrary network faults are not established by an abrupt proxy break. |
| Route display | The SVG joins received coordinates and shows the latest received position. Text provides the coordinates. | It is a schematic plot, not a road map or evidence of the actual path travelled. |
| Repeatability | Reset creates a fresh owned service/browser session; scripted checks establish the fixture's expected results. | Network and rendering timing vary. Manual interventions mark exploration and skip affected client checks; an exploratory run is not a scripted pass. |
| State and access | The prototype maintains views in memory. The local browser host validates its own control registration. | Durable recovery, replay, production retention and application authorisation remain unimplemented. Local registration is not ZooGlass permission enforcement. |

The source review covered
[`FieldUpdates.java`](../../incubator/zooglass/src/main/java/io/zooglass/FieldUpdates.java),
[vehicle rendering](../../incubator/vehicle-tracker/src/view.ts), the
[page labels](../../incubator/vehicle-tracker/index.html), and the documented
[recovery evidence](2026-10-26-recovery.md). The current behaviour is distinct
from the product intentions in [what we're trying to build](../what-is-zooglass.md)
and the required but unimplemented [authorisation contract](../requirements/authorisation.md).

## Documentation corrections

The root README and product explanation no longer call browser controls,
late delivery, recovery or the fault gate future work. The Workbench guide now
separates generic queued-message checks from the vehicle-specific first-snapshot
checks. The viewer guide explains why “Current position” does not guarantee
freshness and why same-sequence changes are not corrections.

No UI wording or runtime change was necessary for this review. Existing labels
already say “Received so far”, “Last received” and “Schematic route”, with
explicit text about sequence gaps, independent snapshots and the route's limits.
Production intent remains framed as ambition, not an achieved general-purpose
product or proven customer value.

Relative document links, references to implementation and formatting were
checked. Application tests were not rerun for prose-only changes; behavioural
evidence is linked above. The canonical diagram and its labels receive their
separate final review next. Acceptance of these claims does not complete the
overall demo programme.
