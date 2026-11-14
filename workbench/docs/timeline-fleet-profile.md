# Bounded memory sequence profile

The controlled host admits `memory-sequence-fleet-v1` for small memory-backed
sequence views. This is the host/admission foundation from the
[fleet assessment](timeline-fleet-assessment.md), not qualification of the full
fleet demo, ordinary network timing, or every sequence configuration.

## Select the profile

In a `timeline-simulation/v2` document, set the optional runtime profile:

```json
{
  "runtime": {
    "configuration": "fleet-runtime.json",
    "sha256": "<SHA-256 of the exact configuration bytes>",
    "storage": "memory",
    "access": "unprotected",
    "initialState": "empty",
    "profile": "memory-sequence-fleet-v1"
  }
}
```

This fragment is not a complete runnable scenario. The configuration still uses
ZooGlass's ordinary contract, validated by the production parser. Admission checks
its shape against the selected profile; setting the name cannot make an unrelated
configuration eligible. Omitting `runtime.profile` preserves the existing
receipt-age profiles and their evidence identities. V1 does not admit this field.

The prepared v2 host must advertise `memorySequenceFleet:1`. Initialization also
carries the selected profile, and the host verifies it against the actual
configuration. A missing capability, mismatched profile or unsupported combination
rejects before creating the runtime. Tests and execution consume prepared JARs;
Java preparation remains an explicit separate command.

## Configuration boundary

- Empty memory storage and unprotected access.
- At most two sources, two views, two fields per view and three fields in total.
- Exactly one matcher per field, using `latestBySequence` or `historyBySequence`.
- Untracked source progress, envelope entity mapping, partial publication and
  accepted late input; no conflict, fact or property policies.
- `unspecified` freshness. This profile does not schedule receipt-age expiry.
- At most 20 streams, retained identities and history entries; existing delivery
  queue bounds and document execution budgets remain in force.

The real selected production strategies perform reconciliation. The host does
not compute a substitute latest value or history. Publication ordering uses the
envelope `publicationSequence`. The bounded identity window affects admission
floors and status even when retained data is small; expected snapshots must use
the same configuration as the run.

Actor connect/disconnect, subscriptions and existing modelled delivery controls
remain available. `service-stop`, `service-start` and `wall-clock-set` are rejected
for this profile. SQLite and receipt-age combinations require separate evidence;
v2 syntax support does not imply they are qualified here.

## Evidence and ordering

Document/trace/run/bundle versions remain v2. Execution identifies the sequence
profile, and environment identity uses its own executor revision. Replay checks
that the saved document selects the same profile as its execution and trace;
changing only an evidence label cannot turn receipt-age evidence into fleet
execution. Existing receipt-age identities stay unchanged.

View effects and receipt targets follow configuration view declaration order.
Fields follow lexical field order. Subscriber delivery follows owned subscription
order. Canonical JSON sorts object keys, not receipt targets, effect sequences or
client frames. Focused checks exercise one input affecting both views, declaration
permutations and two clients; they do not establish arbitrary production thread
or socket ordering.

The [fleet timeline scenario](timeline-fleet-scenario.md) supplies the complete
fixture and independent expectations for late input, history insertion, duplicates,
conflicts and entity isolation.
Repeated fleet runs, a wrong-strategy control, strict replay and ordinary-service
parity follow before the fleet qualification claim is made.

## Foundation checks

The focused host tests cover profile boundaries, initialization agreement,
view/field/source declaration permutations, two clients, same-time sources,
late history insertion, identity conflicts and history/sequence bounds. Evidence
tests cover profile labels through bundles and replay, including coordinated
relabel attempts. Earlier receipt-age cases retain their semantic records.

A bounded smoke used two clients and both view declaration orders, with three
fresh executions per order. Each order reproduced its own trace under long
Node/JVM pauses; strict replay matched all 112 records for each. Independent
checks asserted delivered actor/view order, payloads and publication sequences.
This verifies the foundation exercised here, not the complete fleet programme.
