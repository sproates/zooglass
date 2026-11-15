# Static-view timeline fixtures

These six cases exercise the generic `memory-static-views-v1` family. They use the
shared V3 executor; no fixture-specific runtime or selection algorithm is involved.
Focused execution/replay checks are separate from the finite qualification campaign.
The campaign and final integration promotion remain pending.

| Case                                                                             | Preserved behaviour                                                                                                             |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| [live-match](live-match/scenario.json)                                           | Two feeds supply score and odds; the initially connected client has no invented subscription.                                   |
| [late-update](late-update/scenario.json)                                         | Three sources, two order aliases, and a late inventory contribution.                                                            |
| [bursty-updates](bursty-updates/scenario.json)                                   | Several distinct-time arrivals retain the original final value check.                                                           |
| [sequence-gap](sequence-gap/scenario.json)                                       | A late missing sequence fills ordered history without replacing the latest value.                                               |
| [shared-sequence-across-entities](shared-sequence-across-entities/scenario.json) | Interleaved source sequences retain separate entity histories.                                                                  |
| [mixed-modes](mixed-modes/scenario.json)                                         | Arrival, latest and history disagree deliberately on an older update; two entities and subscriber delivery are checked in full. |

The five converted cases retain **20 publications and 12 literal public-data
checks**, plus one acceptance assertion per publication. Each directory contains
exact original `legacy.json` bytes, the explicitly selected `configuration.json`,
`scenario.json` and `conversion-report.json`. Reports retain hashes, mappings,
resource adaptations and converter identities. Scenario/report JSON is pretty
printed for review; its canonical content is unchanged. Input files retain their
original serialization because their byte hashes are part of provenance.

The bounded configurations use 20 streams, a 20-position identity window, 20
history entries, 128 queued messages and 1 MiB of queued bytes. These selected
limits are adaptations, not a claim of full status equivalence with the ordinary
runner's larger defaults. Each report records the finite input's actual needs.

The [mixed-mode oracle](mixed-modes/ORACLE.md) explains the independently authored
full envelopes. Its expectations were written and reviewed before execution,
without copying runtime results. No converter is involved in that case.

## Run a case

From `workbench/`, with an explicitly prepared host:

```sh
npm run timeline:bundle -- record scenarios/timeline-static/sequence-gap/scenario.json /tmp/static-gap
npm run timeline:bundle -- replay /tmp/static-gap /tmp/static-gap-replay.json
node --import tsx --test test/timeline/static-fixtures.test.ts
```

The focused tests verify retained provenance, run and strictly replay all six
cases, and execute a separate maximum-shape case: three sources, two views, four
fields, two aliases per field and all three selection strategies. That boundary
case is not a seventh campaign fixture. Tests never prepare Java artifacts.

To reproduce a conversion into a new directory, use the retained original and
selected configuration with epoch `1700000000000` and a 64-zero seed; see the
[conversion guide](../../docs/timeline-conversion.md). Converter identity records
the tool/artifact used, so a later tool version need not produce an identical
report. The original input, configuration and deterministic transcription remain
independently validated before execution. None of these cases has random faults;
changing seeds adds no behavioural coverage.
