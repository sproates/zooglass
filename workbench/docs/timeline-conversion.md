# Convert a static-view scenario

V3 runs the `memory-static-views-v1` family through the shared deterministic
executor. It adds public-data and source-acceptance assertions. This implementation
supports explicit conversion and [six reviewed fixtures](../scenarios/timeline-static/README.md).
Their [fixed qualification](timeline-static-qualification.md) passes. The capability
was delivered to main in [PR #179](https://github.com/sproates/zooglass/pull/179).

Prepare the host explicitly using [the setup guide](timeline-guide.md). Tests,
conversion, execution and replay never build Java.

```sh
npm run timeline:convert -- scenarios/sequence-gap.json /tmp/converted-gap --runtime bounded-runtime.json --epoch-ms 1700000000000 --seed 0000000000000000000000000000000000000000000000000000000000000000
npm run timeline:inspect -- admission /tmp/converted-gap/scenario.json ../zooglass/simulation-host/target/zooglass-simulation.jar
npm run timeline:bundle -- record /tmp/converted-gap/scenario.json /tmp/gap-evidence
npm run timeline:bundle -- replay /tmp/gap-evidence /tmp/gap-replay.json
```

Supply a production configuration matching the legacy declarations, with explicit
`maxStreams`, `identityWindow`, `maxHistoryEntries`, `delivery.maxQueuedMessages`
and `delivery.maxQueuedBytes`. Only these five resource limits may differ from the
ordinary compiler's configuration. The production decoder normalizes both sides;
strategy defaults are not duplicated in the converter. The supplied configuration
must fit the [static family](timeline-static-admission.md).

Conversion checks the complete input's stream count, numeric sequence span per
stream and conservative history contribution count against those selected bounds.
It rejects uncertainty, unsupported fields, unsafe integers or inexact numeric round-trips and duplicate
JSON keys. Limits are not silently reduced. Smaller identity windows can change
admission floors even when all data assertions pass; the report records that
adaptation and does not claim original full-status equivalence.

The destination must not exist. Success publishes four files: original `legacy.json`,
exact `configuration.json`, canonical `scenario.json`, and `conversion-report.json`.
The report identifies inputs, converter, prepared host, selected limits, preserved
expectations and original-path mappings. Conversion starts a prepared host only
for configuration inspection; it does not run scenario actions or derive expected
answers. Failed conversion removes its own incomplete destination.

## Supported translation

The converter accepts static source events and non-null server-data checks. It
preserves initial connected/disconnected clients without inventing subscriptions.
It rejects transient initial states, timeline client operations/checks, dynamic
views, route faults, fact metadata, expected rejections and repeated publication
identities. Multiple publications at one timestamp and checks preceding later
same-time actions are rejected rather than rescheduled.

Each publication gains a `source-accepted` assertion. Each server check becomes a
`runtime-data` assertion at settlement of its declared timestamp. This replaces
ordinary HTTP polling with an explicit virtual-time checkpoint; it does not test
HTTP transport, real latency or native concurrency. See the
[full conversion matrix](../../docs/design/timeline-configuration-expansion.md#per-fixture-decision-at-the-baseline).

## Authoring V3 directly

Use `format: "timeline-simulation/v3"` and explicit
`runtime.profile: "memory-static-views-v1"`. V3 admits zero-latency links, source
sends and client connect/disconnect/subscribe/unsubscribe, without retries, faults,
restarts or wall-clock adjustments. Each source connects exactly once at time zero;
source disconnect/reconnect is excluded. Existing V1/V2 profiles keep their meanings.

A `runtime-data` assertion names `id`, `atMs`, `viewId`, `entityId` and an exact
non-null `expected` object. Declare the target in `observationTargets`. The host
reads installed state once, retains its full internal snapshot, and applies the
production `ViewSnapshot.from` projection. Both representations enter the trace;
the assertion compares the complete public `data` object losslessly.

A `source-accepted` assertion names `id`, `atMs`, `actor` and `send` (the source-send
action ID). It requires that actor's sole send at the same timestamp and exactly
one delivered receipt with the complete matching publication identity and accepted
status. The trace records the matched receipt event ID; reuse is forbidden. Earlier
receipts do not affect the check, and cumulative full-receipt assertions remain
unchanged. Full `runtime-snapshot`, `source-receipts` and `client-frames` assertions
remain available. Old document versions reject the new syntax.

## Retained provenance and replay

Converted documents name a relative `conversionReport`; hand-authored documents
omit it. A declared report is mandatory. Saved runs embed both its exact bytes and
the original legacy bytes, so replay never depends on the original directory.
Bundles additionally include and hash fixed `conversion-report.json` and
`legacy.json` members. Removing or changing provenance fails validation before
execution. Validation regenerates transcription, mappings and report claims from
the retained legacy input, without running ZooGlass or calculating expected outcomes.
Fresh execution also repeats production-normalized configuration comparison.

V3 has distinct document, trace, run and bundle identities. The Workbench identity
now includes the legacy parser and shared configuration compiler as well as timeline
modules. Strict replay requires the recorded environment and matching executable
identities. Historical archives still require their pinned tooling. Hashes establish
consistency, not authenticity or a signature.
