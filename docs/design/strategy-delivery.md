# Strategy delivery and verification

Companion to [module shapes](strategy-modules.md) and
[behaviour contracts](behaviour-contracts.md). The sequence below is the proposed
implementation order for review. Each slice must leave the existing service and
demos usable; a capability is advertised only when its implementation and evidence
are delivered.

## A bounded first slice

Extract the three existing policies into the named update modules and bind their
selection during view registration. Preserve current JSON, numerical semantics,
source matching, returned snapshots and live notifications. Keep state in the
existing store and coordination in the existing broadcaster. Do not introduce the
later coordinator, SQLite, a v2 protocol or other strategy modules in this PR.

Expected size: one focused implementation PR including tests and source-map changes.
If unexpected behavioural work is required, separate that decision instead of
hiding it inside an extraction. No browser changes are required.

| Case | Expected outcome | Evidence |
| --- | --- | --- |
| Omitted ordering | Arrival module used; every matching payload replaces the field. | Selection test plus store-level test. |
| Latest selection | 40, 42, 41 leaves 42 after each relevant prefix. | Direct module checks, existing independent reference model and HTTP/WebSocket scenario. |
| History selection | 40, 42, 41 produces [40, 41, 42]; repeated 41 does not grow it. | Same independent model; assert output after every prefix. |
| Equal numeric sequences | 1 and 1.0 retain the first payload for sequence policies. | Existing conflict tests, including reversed arrival order. |
| Precision and malformed values | Preserve negative/fractional/exact large-number comparison; ignore non-numeric or missing sequence without creating phantom entities. | Existing seeded tests and focused module boundary tests. |
| Same source, different strategies | One publication fans into independent latest/history fields and views. | Real service subscription to both; assert the late-event intermediate result before sending another event. |
| Startup versus runtime definition | Both bind the chosen implementation; invalid registration adds neither ID nor matcher. | Existing configuration tests extended to verify both selection paths. |
| Object ownership | Mutating input or returned snapshots cannot mutate another field/entity/view. | Existing nested snapshot tests plus direct strategy result ownership checks. |
| Concurrent subscription/update | Selection change preserves snapshot/stream coordination and ordering. | Existing real-client and broadcaster regression coverage. |

Tests should assert outcomes, not merely a selected class name. A small selection
unit test identifies wiring errors; the integration tests establish that runtime
processing actually respects the choice. Expected results must not call the
production strategy or sequence helper. Any discovered bug receives a reproducer
that fails for that bug before the fix.

## Delivery sequence

| Step | Scope and completion | Likely PR boundaries |
| --- | --- | --- |
| 1. Named update modules | The first slice above; configuration demonstrably chooses executable modules. | One implementation PR. |
| 2. Identity and durable baseline | Add explicit v2 source identity/outcomes and coordinator staging, then the local transactional state store and restart evidence. Persist the existing policies before adding many new kinds of state. | Separate ingress/state-ownership, SQLite/recovery, and acceptance changes as needed; design details stay within the agreed contracts. |
| 3. Relationships and conflict | Explicit lookup keys, independently retained source candidates and priority selection. | Mapping/rejection, then contribution selection and combined tests. No retroactive mapping or arbitrary joins. |
| 4. Progress and freshness | Scoped contiguous progress and gap metadata, late-policy selection, receipt-age and partial publication. | Progress/gaps first; freshness/publication separately. No event-time window engine. |
| 5. Retained fact corrections | Stable fact revisions/tombstones and bounded active-fact sum with retirement. | Fact revision first; derived correction and retention acceptance separately. No arbitrary recomputation graph. |
| 6. Recovery and queue policies | Explicit fresh snapshot/empty state/version contract, byte/message bounds and safe coalescing. | Recovery semantics, then queue selection and failure acceptance. No historical replay cursor. |
| 7. Orders | Resume both planned modes using the delivered capabilities. Explain missing inputs, priority/relationship choices and retained progress rather than duplicating processing in the page. | Existing browser/acceptance slices, split only when justified. |
| 8. Sports | Both modes, with retained goal corrections and independently progressing market data. | Sources, browser, acceptance; keep domain rules in the scenario. |
| 9. Access and collection acceptance | Implement the separately required permission contract, then exercise revocation with recovery and review the complete collection. | Existing authorisation design/enforcement slices; final combined evidence and presentation review. |

PR #99 merged on 29 October as `3011f6e`; reuse its order-source foundation rather
than starting another order implementation. Its publication-sequence examples are
useful evidence but do not substitute for retained-fact corrections. Existing
vehicle demos remain supported, and orders and sports retain their interactive and
continuous modes. Workbench verification may be added throughout the service steps;
new browser presentation waits until the strategy design is accepted and the
relevant service contracts are available.

Persistence moves ahead of richer strategy implementations so state ownership is
exercised early. Each later stateful strategy extends the transactional store and
its restart tests in the same slice. Exact counts for the full programme are not
fixed; the table defines scope boundaries rather than enormous single PRs.

## Capability-to-demo coverage

Scene additions below are planned work. Preserve each demo's coherent purpose;
none needs to expose every setting or show every failure at once.

| Capability | Primary demo and observable scene | Existing starting point |
| --- | --- | --- |
| Ordering, duplicates, shared source with different strategies | Vehicles: current map and received journey react differently to delayed 41. | Latest/history fixtures already exist; ensure the presentation makes the contrast explicit. |
| Partial inputs and distinct source rates | Orders: accepted and paid while inventory is unknown; later inventory fills its own field. | Merged order source slice. |
| Identity mapping and source conflict | Orders: distinct payment/reservation IDs map to an order; preferred courier status wins despite a later backup report. | Extend the producer fixture once the service contract exists. |
| Freshness and gap policy | Vehicles: reporting silence versus late/missing position with a declared source-progress promise. | Existing continuous faults supply useful scenes; add genuine service progress metadata. |
| Corrections and derived views | Sports: disallowed goal revises the score and retained event history; old revision redelivery has no effect. | Existing replacement fixtures; add retained-fact scenario for the new contract. |
| Service restart and duplicate recovery | Orders: kill and restart ZooGlass, resend unacknowledged publication, observe restored state and one effect. | Workbench drives restart; the browser displays recovered snapshots. |
| Snapshot/stream continuity and slow viewers | Vehicles or orders: one viewer reconnects/stalls while another keeps updating. | Existing client fixtures; add v2 recovery and queue-policy evidence. |
| Access loss | Orders: revoke one viewer while another remains authorised; denied reconnect. | Extend the order experience after permission enforcement is delivered. |

Every scene should state its selected policy, what the viewer should notice,
what ZooGlass contributes and which source events are simulated. Keep detail in
an accessible explanation area rather than pushing the domain display down the
page. A scene can explain a capability whose strongest race/crash evidence remains
an automated service test.

## Quality and cost acceptance

Review module responsibilities and names, explicit state ownership, simple control
flow and test readability in each PR. Split growing modules by responsibility,
not a fixed line count. Refactor a concrete obstacle with its behavioural evidence;
do not create all the future modules as empty shells. Update actual source maps
when code changes, leaving these design diagrams labelled as proposed structure.

For each strategy, cover normal and invalid configuration, boundary input, no-op,
state isolation and relevant interactions. The first matrix above is the pattern.
For later persistence/revisions, add real crash and retention-boundary cases, not
only mocked storage results. Bring combinations in when introduced, then repeat
the selected end-to-end stories at collection acceptance.

Use existing Java tests for policy/store/transaction logic, Workbench core tests
for real socket/lifecycle cases, and limited demo/browser tests for rendering and
bindings. A test is placed where the failure is observable with least machinery.
Do not run browser scenarios to prove a numerical comparison. Keep the prepared
JAR launch contract: build explicitly, then reuse it for sessions.

Recent baseline: [Workbench run 40930191480](https://github.com/sproates/zooglass/actions/runs/40930191480)
for the merged order slice had all seven checks pass. Job execution durations were
approximately 2m06s for standard tests/build, 3m45s for browser-host, 1m15s/2m42s
for native lifecycle, and 56–61s for browser engines. These are one run's job
intervals including setup, not test-only timings or a performance target. The
critical path was about four minutes with short queue waits. Local existing logs
record 158 standard checks in about six seconds, but that different environment
is not directly comparable with hosted job duration.

The initial design changes only Markdown and performs link/fence/diff checks.
The first implementation uses existing appropriate CI jobs; do not add a duplicate
strategy job to every platform. When elapsed validation grows materially, inspect
queue, preparation and test phases before changing coverage. Reuse observed data
rather than scheduling a separate benchmarking programme. Existing local coverage
artifacts are not tied to a verified current commit, so no fresh percentage is
claimed by this audit.

### Presentation and browser baseline

When browser work resumes, publish tested versions for current and previous stable
major releases in the chosen Chromium, Firefox and Safari/WebKit scope, with
matching supported mobile OS/browser combinations. An engine test alone does not
prove every branded browser/device combination. Required API detection and initial
HTML upgrade guidance cover unsupported clients without a legacy implementation.
Choose and record the exact versions at that delivery point, not from this design's
date. No physical-device qualification or owner-operated phone sign-off is required.

A demo is accepted when its domain activity and key result are apparent on the
initial desktop/phone-width view, explanations identify the demonstrated policy,
controls remain readable and usable, and the rendered scene is reviewed. Check the
representative six-order/three-match load with no unbounded DOM/history growth,
network errors or repeated long tasks attributable to avoidable rendering. Inspect
interaction responsiveness and asset costs on an ordinary-device browser profile;
profile observed bottlenecks rather than promising a hardware-independent frame rate.
Prefer ordinary HTML/CSS; justify a heavier renderer by a concrete feature benefit.

## Review decisions

The design chooses a small concrete module extraction first, scoped source promises,
explicitly supported combinations, transaction-owned state, early single-instance
persistence and one capability-led demo sequence. Alternatives deliberately left
outside this delivery include global ordering, arbitrary joins, event-time windows,
distributed storage, a general expression engine and transition replay. They can
be reconsidered through a new contract with evidence, rather than accepted as
ambiguous configuration.
