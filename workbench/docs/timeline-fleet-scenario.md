# Fleet timeline scenario

The [fleet timeline document](../scenarios/timeline-fleet/scenario.json) adapts the
existing [three-vehicle contract fixture](../scenarios/vehicle-fleet-contracts.json)
to the bounded [memory sequence profile](timeline-fleet-profile.md). It runs the
real latest-by-sequence and ordered-history strategies under virtual time.
It does not change the browser demo or automatically convert legacy scenarios.

From `workbench/`, with the host already prepared:

```sh
npm run timeline:execute -- scenarios/timeline-fleet/scenario.json /tmp/fleet-run.json
npm run timeline:bundle -- record scenarios/timeline-fleet/scenario.json /tmp/fleet-bundle
npm run timeline:bundle -- replay /tmp/fleet-bundle /tmp/fleet-replay.json --require-passed
```

Output paths must be new where required by the command. Execution, replay and
tests never build Java. Preparation remains the separate `prepare:timeline` step.

## What it preserves

The document retains all 16 publication intents, six subscriptions and the state
meaning of the 20 legacy HTTP/client checkpoints. Two independent sources report
position and operation for `car-17`, `car-28` and `car-39`. The fleet view combines
those contributions; the journey view retains ordered locations. Explicit
connections replace implicit startup, and settled virtual timestamps replace
polling waits. All six view/entity pairs are declared observation targets.

Ordering uses envelope `publicationSequence`, not the similarly named display
payload field. The runtime configuration uses resource bounds of 20. Its identity
window changes observable admission floors: initial location sequence 40 gives
floor 21; initial operation sequence 100 gives floor 81. The document expects
those values explicitly rather than copying the legacy service's larger-window
metadata.

## Independent expectations

The expected outcomes were written from the publication contract before execution.
The authoring data states the accepted versions, selected values, ordered histories,
source floors and receipt targets. Serialization produces complete snapshot,
client-frame and receipt envelopes; it does not run a second reconciler or obtain
expected values from ZooGlass output.

| Publication at virtual ms | Expected result |
| --- | --- |
| 60–110 | Six initial contributions receive versions 1–6; positions fan out to both views and operations update only fleet state |
| 180 | Car-17 position 42 replaces its latest value and extends history, version 7 |
| 190 | Car-28 operation 102 replaces its latest operation, version 8 |
| 240 | Car-17 position 41 is accepted at version 9; latest position stays 42 and history becomes 40, 41, 42 |
| 250 | Car-28 operation 101 is accepted at version 10 without changing the selected value or emitting an update |
| 270 | Identical position 41 returns a duplicate receipt with original version 9 and targets |
| 280 | Changed content at position identity 42 is rejected as `identityConflict` at current version 10 |
| 290 | Identical operation 102 returns a duplicate receipt with original version 8 and targets |
| 300 | Changed content at operation identity 102 is rejected as `identityConflict` at current version 10 |
| 310–320 | Car-39 advances independently; location receives version 11 and operation receives version 12 |

Accepted unchanged input is distinct from a duplicate: the former gets a new
receipt version, while the duplicate retains the original version and targets.
Neither should regress selected data. Rejections have empty targets and do not
advance the global version. Final fleet/journey versions are 7/9 for car-17,
8/2 for car-28, and 12/11 for car-39.

Assertions cover partial state, provenance, freshness/status, bounded admission
floors, full source receipts and complete cumulative client frames. The client
receives 28 frames: six subscription acknowledgements, six empty snapshots and
16 updates. The unchanged cases explicitly require that count to remain unchanged;
a final-state-only check would miss redundant or incorrect messages.

## Maintain the fixture

Edit the explicit input/outcome tables in
[author.ts](../scenarios/timeline-fleet/author.ts), then regenerate the checked-in
configuration and runnable document from `workbench/`:

```sh
node --import tsx scenarios/timeline-fleet/author.ts
```

The generator only serializes authored expectations. It does not start a service,
read a trace or infer transitions. The generated document uses one array entry
per line to keep repeated complete envelopes navigable. Tests check generated
bytes and compare publication/subscription/checkpoint coverage with the legacy
fixture, so changes remain reviewable at the authoring table.

## Validation

The first prepared-host execution passed all 62 authored assertions without
runtime-derived changes to the expected outcomes. Three deliberately wrong
expectations—unsorted history, missing second-view receipt targets and accepting
an identity conflict—each fail at their named assertion. The five-file portable
bundle replays all 432 records exactly under the matching environment.

## Scope

This slice establishes an executable fixture and independently authored oracles.
The broader repeatability campaign, a deliberate wrong-strategy runtime control,
and parity through ordinary source/client WebSockets and HTTP remain separate
acceptance work. The original real-service fixture remains available and is not
replaced by this deterministic scenario. No cross-platform or browser qualification
is inferred from a passing timeline run.
