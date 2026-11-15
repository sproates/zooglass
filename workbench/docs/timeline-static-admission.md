# Static configuration admission

The `memory-static-views-v1` foundation checks whether a configuration belongs to
the accepted broader family. [V3 conversion and execution](timeline-conversion.md) use this admission path.
Existing V1/V2 execution and profile classification retain their meaning.

Use a prepared host JAR (see [setup](timeline-guide.md)):

```sh
npm run timeline:inspect -- static-configuration scenarios/timeline-fleet/runtime.json ../zooglass/simulation-host/target/zooglass-simulation.jar
```

An optional third path supplies a reference configuration:

```sh
npm run timeline:inspect -- static-configuration bounded-runtime.json ../zooglass/simulation-host/target/zooglass-simulation.jar original-runtime.json
```

The host production-decodes and validates both configurations. It checks the
supplied configuration against the family and compares normalized configurations,
ignoring only `maxStreams`, `identityWindow`, `maxHistoryEntries`,
`delivery.maxQueuedMessages` and `delivery.maxQueuedBytes`. Omitted production
defaults are normalized by ZooGlass, not reimplemented in Workbench. The reference
need not fit the family. Resource equivalence does not prove equivalent scenarios
or full status envelopes; changed limits can change admission floors.

Read `requestedProfile.eligible` and its path/rule `issues`. When a reference is
supplied, also read `requestedProfile.comparison.equivalent` and `differences`.
These are separate decisions. Exit 0 means an assessment was produced, including
an ineligible or different configuration; exit 1 means invalid input, unsupported
host capability or a failed inspection. `execution: "not-checked"` is intentional.
The report hashes the exact input bytes and prepared host artifact.

The family admits memory storage, up to three sources, two static views, three
fields per view and four in total. Fields may mix arrival, latest-by-sequence and
history-by-sequence, with one or two distinct event types from one source per
field. It requires envelope entity mapping, partial publication, untracked source
progress, unspecified freshness and acceptance of late inputs. Resource ceilings
are 20 streams, 20 sequence positions, 20 history entries and delivery queues of
128 messages/1 MiB. Facts, aggregation, source priority, required contributions,
SQLite, runtime restarts and controlled writer/wall-clock faults are excluded.
See the [accepted expansion contract](../../docs/design/timeline-configuration-expansion.md)
for the complete planned execution and conversion boundary.

Inspection creates no runtime, store, session or scheduled work. The additive
`memoryStaticViews:1` capability is required; an older artifact fails explicitly.
The private host startup path independently checks the supplied bytes and requested
profile before composing a generation-one runtime at time zero. V3 document,
trace, run and bundle identities are distinct. Execution additionally requires
`publicSnapshots:1` on protocol 2, so an admission-only host cannot execute V3.

V3 data assertions use production `ViewSnapshot.from` on the
side-effect-free installed snapshot: internal data contains retained sequence and
payload envelopes, while legacy HTTP expectations contain public payload values.
Both full internal observations and public projections remain in the trace.
