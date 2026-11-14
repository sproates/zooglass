# Fleet timeline assessment

The existing [three-vehicle fleet fixture](../scenarios/vehicle-fleet-contracts.json)
is a useful next test of the deterministic simulator. It is **not currently
supported**. Giving the receipt-age example vehicle names would not preserve the
fleet's latest-position and ordered-history behaviour.

This assessment selects a bounded memory-backed sequence profile as the next
extension. It does not admit that profile, convert the legacy format, qualify
fleet execution, or change the browser demo.

## What must survive adaptation

The fixture has two sources, two views, three field definitions, three entities,
six subscriptions and 16 publications. Its 42 timeline entries include 11 client
checks and nine HTTP checks. The runtime configuration uses publication sequence,
not the similarly named field inside the payload, for ordering.

| Behaviour | Existing fleet contract | Current simulator gap |
| --- | --- | --- |
| Independent contributions | `fleet-state.position` and `.operation` retain values from separate sources | Configuration profile admits only one source and one field |
| Latest position | Sequence 42 stays current when 41 arrives later | Only arrival replacement is admitted |
| Journey | `received-journey.positions` inserts 41 between 40 and 42 | Ordered history is not admitted; one publication affects two views |
| Identity | Identical retries retain the original accepted version and targets without reapplying; changed content at the same identity is rejected | Receipt assertions exist, but multi-view target lists need coverage |
| Isolation | Equal sequence numbers on three vehicles and two sources remain independent | Multiple entities work; this combined source/view shape is unqualified |
| Freshness | Default `unspecified`, with no receipt-age expiry | Current profile requires `receiptAge` |
| Observation | Real socket frames and polling HTTP checks | Explicit settled-time frames and non-repairing installed snapshots exist in v2; legacy waits are not equivalent |

The legacy compiler also requests 100,000 streams, 10,000 identities and 10,000
history entries, above the controlled profile's limits of 20. A bounded fixture
can lower these limits for its six source/entity streams and short histories.
This changes observable metadata: with an identity window of 20, sequence 40
sets the admission floor to 21 and sequence 100 sets it to 81, rather than the
legacy floor of 1. Expectations must include those bounded floors and resulting
status/version effects. Business outcomes can be preserved; the complete legacy
frames are not interchangeable with the bounded configuration.

On 14 November 2026, at `6e33990`, configuration-only inspection with the prepared
host accepted the production configuration syntax but returned `unsupported`
for both the compiled fixture and a copy with all three resource limits set to
20. No runtime or store was started and no Java build was triggered. The ordinary
legacy inspector separately reports observation and receipt adaptation issues;
it is conservative advice, not a complete admission decision.

## Smallest coherent extension

Add a separately identified **memory sequence profile** (proposed identifier
`memory-sequence-fleet-v1`), scoped to v2 documents:
up to two sources, two views and two fields per view, with at most three fields
in total. Keep untracked progress, envelope entity mapping, partial publication,
exactly one matcher/input per field, no conflict/fact/property policies, accepted
late input, unprotected access, and the existing resource bounds. Admit `latestBySequence` and `historyBySequence` with `unspecified`
freshness. Do not combine this new profile with SQLite, restart or adjusted clocks
until that combination has its own evidence. Admission must explicitly reject
`service-stop`, `service-start` and `wall-clock-set` for this profile even though
v2 syntax can represent them. Actor connection and disconnection remain supported.

Keep the existing receipt-age profile and its admission tests intact. The new
configuration identity/capability must be explicit in admission and initialization;
old hosts must reject it before execution. Document version and run/trace format
are separate contracts: do not relabel existing evidence merely to add a
configuration strategy. Decide the exact capability identifier in the host slice,
with tests for the Workbench/host agreement and replay identity. Audit the current
profile coupling through execution, trace/run evidence, replay and bundles: a
fleet run must not be labelled `memory-arrival-v1` or `receipt-age-restart-v1`.

The host must continue to invoke production `ViewCoordinator`, `ViewTransitions`
and the selected `LatestBySequence`/`HistoryBySequence` strategies. Workbench owns
input order and observations; it must not implement latest-value or history logic.
The same explicit bounded configuration should run through the ordinary service
for parity, rather than comparing different limits or strategy defaults.

Before widening admission, audit observable ordering across view bindings, field
results, receipt targets, state effects and subscriber dispatch. `ViewTransitions`
uses a declared binding list, fields use lexical order, and subscriber delivery
has insertion-order ownership. Verify those paths with at least two clients;
maps also exist in configuration and retained state.
A map used for lookup is harmless, but iteration that controls emitted array order,
version assignment or scheduling needs an explicit rule. Canonical object-key
encoding cannot fix a nondeterministic sequence of effects. Include declaration
permutations and multiple fresh JVMs in the proof; do not just remove the profile
checks and infer safety from a passing run.

## Delivery and acceptance

1. **Host and admission boundary.** Implement the bounded profile, inspect and
   initialize the real two-view configuration, and prove complete target/state
   ordering for one event affecting both views. Test unsupported combinations and
   numeric sequence/history limits. Preserve the existing profiles' focused tests.
2. **Fleet document and independent oracles.** Author a v2 adaptation using the
   same 16 publication bodies and six subscriptions. Add explicit connections,
   complete receipt/frame expectations and six declared view/entity targets.
   Preserve the legacy checkpoints' intended state; replace polling waits with
   settled virtual timestamps. Use literal expectations for partial state, latest
   replacement, late-history insertion, identical duplicates, changed-content
   rejection and final isolation. Assert actual receipt reasons and full targets,
   not just unchanged final data. Include full provenance, bounded admission floors,
   statuses, versions and client publication sequences. Expectations are authored
   before the run, never captured as golden output from the implementation.
3. **Repeatability and real-interface parity.** Run a bounded fresh-process matrix
   with long host pauses, exact traces and strict replay. Separately feed the same
   configuration and publications through ordinary source/client WebSockets and
   HTTP. Gate each comparison on receipts and observed state, not elapsed sleeps.
   Compare independently expected business projections and receipt semantics;
   do not require real socket timing or frame coalescing to equal the simulator.

Same-time multi-source bursts need separate cases because timeline input phases
settle before writer turns. The legacy fleet fixture uses distinct timestamps;
that does not establish burst parity. Include a same-source/two-view update and a
same-time two-source update to expose ordering and coalescing rules. A rejected
publication or unchanged latest value can still have receipt/status effects:
check the production outcome rather than assuming no work occurred.

The repeatability gate also needs a targeted wrong-strategy control: replacing
latest-by-sequence with arrival must fail the late-input assertion, not merely
an artifact identity check. Ordered-history, second-view fanout and conflicting-identity rejection each need
a negative oracle check that fails on a wrong result. Bundle/replay tests must
reject altered profile identities. Use one bounded campaign and targeted checks,
rather than multiplying every feature into a new campaign.

Each step needs focused validation and review before the next. Tests consume
prepared artifacts; preparation remains explicit. The existing real-service
fleet scenario remains complementary evidence, not an automatic proof that the
new profile is deterministic. No browser or device acceptance is part of this
bounded simulator extension.

## What remains outside this step

This is not support for the entire legacy JSON format. Dynamic views, browser
faults, implicit reconnect behaviour, arbitrary configuration sizes and automatic
conversion remain separate. Order/Sports require their own assessment of entity
mapping, priorities, progress, required contributions and fact/correction policies.
Those combinations are not covered by admitting sequence-based fleet views.
