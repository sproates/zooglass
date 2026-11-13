# Timeline document and trace contracts

This POC adds a strict **syntax contract**, an encoding contract and a legacy
compatibility inspector. It does **not** add a general scenario executor.
`timeline-simulation/v1` and `timeline-trace/v1` are experimental contracts on the
POC branch, not released compatibility promises. The two executable fixed proofs
retain their private format and existing commands.

From `workbench/`:

```sh
npm run timeline:inspect -- scenario scenarios/simulation/receipt-contract.json
npm run timeline:inspect -- legacy scenarios/*.json scenarios/browser/*.json
npm run timeline:inspect -- trace /path/to/semantic-trace.jsonl
```

The inspector never starts or builds Java. `syntax: valid` means the document's
shape, references and bounded numeric values passed validation. It does not mean
that its runtime configuration exists, matches its hash, is accepted by ZooGlass,
or that its actor lifecycle is executable. The configuration file is resolved
relative to the scenario by a future executor, which must verify its byte hash and
use the full existing ZooGlass configuration parser. No second strategy language
is introduced here. The example is a contract example, not an executed acceptance
fixture. `execution: unsupported` is deliberate; the capability gate rejects all
general documents until an executor is qualified. Trace inspection likewise checks
structure, not whether the recorded execution or assertions actually happened.

## Scenario contract

All fields are required; unknown fields and unsupported operations are errors.
The [example](../scenarios/simulation/receipt-contract.json) shows the whole shape.

- `format`, `id`, `clock.epochMillis`, lowercase 256-bit `seed` and finite `untilMs`
  identify the run. Time values are safe nonnegative integer milliseconds. The
  horizon is at most one hour, and epoch plus horizon must remain a safe integer.
- `runtime` identifies the external configuration and its SHA-256, plus the admitted
  boundary: empty memory storage and unprotected access. Other modes are rejected.
- `actors` declares unique source/client IDs. Every actor needs one bidirectional
  `links` entry; only zero latency is admitted in this grammar increment. These are
  logical links, not real sockets. All actors initially have no connection.
- `publications` retains unique publication IDs and full raw publication objects.
  Payload numbers remain exact. Publication validation belongs to the real runtime;
  malformed publication content may be intentional test input. Actor ID and runtime
  source ID are distinct; the full publication retains its own source identity.
- `actions` have unique IDs, declared times and actor references. Admitted kinds
  are `connect`, `disconnect`, `source-send`, `source-retry`, `client-subscribe`,
  `client-unsubscribe`, `writer-stall` and `writer-release`. Source actions refer
  to retained publication IDs; retry means identical original bytes/identity, not
  a new publication. Subscriptions name view/entity IDs; release has boolean `fail`.
  A future executor must reject impossible lifecycle/retry sequences before running.
- `assertions` have unique IDs shared with actions, times and actor references.
  `client-frames` and `source-receipts` compare the **entire ordered cumulative
  list** observed by that actor through the settled timestamp against `expected`.
  An empty list explicitly asserts absence. Expected envelopes include meaningful
  versions, targets, provenance and status; no partial expected-value polling.
- `limits` bounds turns, rounds, queued events, pending messages and trace bytes.
  Parser ceilings are 100,000 turns, 1,000 rounds, 10,000 queued events/messages,
  and 16 MiB trace data. Documents allow at most 100 actors/links and 1,000 each
  of publications/actions/assertions. These are admission bounds; this slice does
  not enforce runtime budgets because it does not run documents.
- `end` permits or forbids future tasks and requires zero messages and held frames.
  All work due at or before the horizon must have settled before final success.

The accepted design's `(time, round, phase, ordinal)` ordering applies: lifecycle
changes phase 0, deadlines phase 1, inputs phase 2. Declaration order is preserved
within each phase, and derived same-time work enters the next round. Assertions
observe after all executable work at that timestamp settles. No invisible drain
occurs between same-time publications. Seeded fault rules, delayed/dropped links,
restart, wall-clock changes, dynamic views, HTTP snapshot reads and other assertion
kinds remain rejected by this grammar increment, not silently ignored. Their
syntax and runtime evidence belong to subsequent increments.

## Exact JSON and trace structure

The lossless parser rejects duplicate keys (including escaped aliases), trailing
input, non-JSON numbers, invalid strings/unpaired surrogates, nesting beyond 64,
and input/canonical output beyond 16 MiB. Decimal input and expanded output have
at most 4,096 digits, including zero padding; exponent magnitude is at most 4,096.
The parser accounts for canonical UTF-8 bytes as values are read, so compact
exponent tokens cannot accumulate an oversized expanded value before rejection.
JSONL shares one canonical byte budget across records, including every newline;
it does not grant a separate 16 MiB allowance to each record.
Object keys sort by Unicode scalar value; arrays keep order. UTF-8 output uses
JSON string escaping, no insignificant whitespace, plain decimal numbers,
normalised negative zero and removed insignificant fractional zeros. Large integers
and precise fractions never pass through JavaScript `number`. Metadata integer
validation rejects fractions before numeric conversion, preventing rounding into
apparently valid times or limits. This encoding is independently tested; the
private proof host's current Java encoding is not claimed as this new trace format.

A semantic JSONL artifact starts with `format: timeline-trace/v1`,
`scenarioSha256` (hash of the canonical scenario UTF-8 bytes) and `untilMs`.
Each following event has `kind`, unique `eventId`, nullable `parentId`, a four-part
`key`, `actor`, positive `runtimeGeneration`, nullable positive
`connectionGeneration` and object `data`. Parents must precede children; agenda
keys cannot decrease. Multiple effects may share a turn key. Event kinds are
`action`, `scheduled`, `cancelled`, `delivered`, `dropped`, `receipt`, `state`,
`frame` and `assertion`. `data` preserves raw semantic envelopes; kind-specific
runtime effect schemas are not yet validated by this structural inspector.

The final `result` contains `outcome`, `eventCount`, `pendingFutureTasks`,
`pendingMessages` and `heldFrames`. Outcomes distinguish `passed`,
`assertion-failed`, `limit-exceeded` and `infrastructure-failed`. Missing final
results, count mismatches, forward parents, duplicate IDs, decreasing keys and
passing results with held frames/messages are rejected. Structural validation
alone cannot confirm horizon settlement, end-policy compliance, causal truth,
assertion correctness or runtime capability support. Full manifests, executor
emission, verification replay and diagnostic artifact handling remain later work.

## Honest legacy compatibility assessment

Audit at POC base `a48a13c`: **19 JSON scenarios, 369 timeline entries, zero
unchanged files executable through the controlled host.** These legacy files are
identical on the final demo main delivery. Generated demo schedules and browser
UI scripts are outside this JSON-format census.

| Legacy kind             | Entries | What can carry over                                    | Remaining semantic or runtime work                                                    |
| ----------------------- | ------: | ------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `source-event`          |     108 | Identity, epoch, sequence, entity, type, exact payload | Configurable host; explicit receipt assertions/retries instead of send-side waits     |
| `client-subscription`   |      27 | Subscribe/unsubscribe and view/entity targets          | Actor connections and subscriptions must execute through the controlled adapter       |
| `view-check`            |     113 | Expected data, including explicit absence              | Recorded runtime reads after settlement; prevent reads repairing missing alarms       |
| `client-view-check`     |      90 | Expected business values                               | Replace waiting for a value with full cumulative observed-frame assertions            |
| `client-state`          |      26 | Connect/disconnect intent                              | Explicit completion, generation, reconnect and subscription-retention rules           |
| `view-definition`       |       3 | Existing full runtime view contract                    | Controlled registration path absent; grammar rejects it                               |
| `data-connection-fault` |       2 | Intent to interrupt delivery                           | Browser route/HTTP control semantics do not equal a modelled link; grammar rejects it |

Seventeen files contain snapshot checks, eleven client checks, eight client-state
changes, two dynamic registration, and one browser data-route faults. These counts
overlap. Two files contain expected publication rejections. One has transient
initial client state. `runtime-view-definition.json` contains an assertion before a
later action at the same timestamp: simply moving that check to a settled barrier
would change its meaning. The inspector reports paths for these issues and also
flags same-time publication bursts and lifecycle/input reordering when present.
No same-time source burst occurs in this current corpus; that detector is covered
by a deliberately constructed test.

Most domain data and publication/subscription intent can therefore be reused.
That is **not** a supported percentage of scenarios. Every fixture still needs a
configuration-capable host, explicit execution/observation semantics and new
independent expected results before deterministic compatibility can be claimed.
Retain real-interface tests for browser recovery and production timing. An explicit
legacy converter and representative demo parity remain later work; do not rename
or silently change the existing `simulate` or `integrate` commands.

## Both formats and explicit run modes

Retain the legacy scenario format for real-interface integration and the versioned
format for controlled execution. An eventual common Workbench entry point should
make preview, integration and deterministic execution explicit, while retaining
existing commands for compatibility. Mode selection cannot grant determinism:
unsupported format/mode/capability combinations must fail before execution, never
silently fall back. Exact CLI spelling and a converter are not implemented here.
Equivalent fixtures can later run in both environments as complementary evidence;
matching domain outcomes does not imply their transport timing is identical.

The intended support matrix keeps those distinctions explicit:

| Format    | Mode          | Current support                                                            | Intended boundary                                                                    |
| --------- | ------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Legacy    | Preview       | Existing `simulate` prints planned actions.                                | No service execution or behavioural pass.                                            |
| Legacy    | Integration   | Existing `integrate` uses real service interfaces.                         | Retain real scheduling, sockets and browser-specific companions.                     |
| Legacy    | Deterministic | Rejected; no implicit conversion.                                          | An explicit, reviewed conversion must resolve changed semantics first.               |
| Versioned | Preview       | Syntax inspection only; no scheduled-plan renderer yet.                    | A future preview adapter can show the admitted plan without executing it.            |
| Versioned | Integration   | Unsupported.                                                               | A qualified real-interface adapter can later provide domain-outcome parity evidence. |
| Versioned | Deterministic | General documents are unsupported; only the separate fixed proofs execute. | Admit only the capabilities implemented and verified by the controlled executor.     |

A common entry point should require a mode rather than infer execution semantics
from the format. The existing commands can remain explicit aliases. Proposed
result labels are `preview-only`, `integration-verified` and
`deterministic-verified`; these labels and mode dispatch are not implemented by
this inspector. A preview cannot pass behavioural assertions. Integration parity
should compare independently expected domain outcomes, not promise equal transport
timing or identical deterministic traces.

Keep conversion separate and reviewable: produce a versioned document and report
unresolved polling assertions, same-time observation boundaries, reconnect
retention and runtime reads. First qualify the admitted deterministic subset;
then add a thin dispatcher and any justified parity adapter. Supporting three
modes does not require three independent execution implementations or a universal
converter now.
