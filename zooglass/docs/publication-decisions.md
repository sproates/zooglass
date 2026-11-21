# Publication decision results

`ViewCoordinator.applyExplained(publication)` returns the ordinary
`PublicationOutcome` beside a `PublicationDecision`. This is an optional Java
runtime API. It does not yet enable a timeline report or a service endpoint;
[the explanation design](../../docs/design/event-explanations.md) describes those
planned integration steps.

The explained and ordinary methods use the same identity checks, strategies,
staging and installation. The explanation is assembled before installation and
returned only after processing succeeds. It is never saved in SQLite or added to
the existing service receipt JSON.

## Supported processing

The production API supports static arrival, latest-by-sequence and
history-by-sequence fields, including multiple event types from the same source.
Fields must use one source, envelope entity mapping, independent selection, partial
publication, untracked progress, unspecified freshness and acceptance of late
inputs. Memory and SQLite both work. Unsupported configurations fail before any
publication processing, including after a view has been registered. Timeline
resource and action limits remain the simulation host's responsibility.

## Read the result

`publication-decision/v1` records stream identity, publication sequence, status,
reason, version, `installed` and ordered target/field decisions. View order follows
configuration; fields follow canonical configuration order. A matched field records
its strategy, update reason, `retainedChanged` and `publicChanged`.

| Update reason | Meaning |
| --- | --- |
| `ARRIVAL_REPLACED` | The arrival strategy replaced its retained contribution |
| `LATEST_INITIAL` | No valid sequence was retained by the latest strategy |
| `LATEST_NEWER` | The incoming sequence is newer |
| `LATEST_OLDER` | The incoming sequence is older and was ignored |
| `HISTORY_INSERTED` | The history strategy inserted a new sequence |
| `LATEST_EQUAL`, `HISTORY_EXISTING` | The strategy saw an already-retained sequence |
| `SEQUENCE_MISSING` | The strategy could not read a valid incoming sequence |

The final two rows are lower-level strategy results. Admitted runtime publications
carry a valid sequence, and duplicate/conflicting identities are normally recognised
before update evaluation. They are not additional timeline scenario capabilities.

`retainedChanged` reports the strategy's contribution update. `publicChanged`
compares projected payload values and provenance through the existing public
snapshot projection. It excludes version, publication-sequence and status metadata.
An arrival update with the same payload may therefore have `retainedChanged: true`
and `publicChanged: false`, while the ordinary receipt still lists a changed field.
No payload values are copied into the decision result.

An applied/committed publication has `installed: true`, even if no view matched.
A rejection has `installed: false` and no target decisions: any candidates staged
before rejection were discarded. A duplicate also has no current target decisions.
Its ordinary receipt retains the original target outcomes, which are historical;
they must not be presented as new changes. Detailed original decisions are not
persisted or reconstructed on retry.

Unexpected exceptions propagate without returning a decision result. Absence of a
result is not proof of rollback: an exception after installation may leave installed
state. Callers must not turn a missing result into a claim that nothing committed.
