# Explain a recorded timeline

`timeline:explain` reads a complete [portable run bundle](timeline-artifacts.md)
and writes a plain-text or JSON report. It validates the retained evidence without
starting Java, requiring the original JAR or contacting the network.

From `workbench/`, with Node 26 and dependencies installed:

```sh
npm run timeline:explain -- /path/to/bundle /tmp/explanation.txt --format text
npm run timeline:explain -- /path/to/bundle /tmp/explanation.json --format json
npm run timeline:explain -- /path/to/bundle /tmp/event.txt --format text --event event-12
```

Choose a new output file outside the bundle. Existing files are never overwritten;
symlink aliases cannot place the report inside the evidence directory. Unknown
event IDs, invalid evidence and unsupported options fail without writing a report.

## What it explains

V5 records the real runtime's static publication decisions alongside receipts.
Use `timeline-simulation/v5` explicitly with the existing
[`static-views-restart-v1` profile](timeline-static-recovery.md); its configuration
bounds and lifecycle support are unchanged. Older formats are not silently
upgraded, and converter output remains V3.

For a supported publication, the report identifies its source attempt and produced
receipt, runtime and connection generations, publication identity, outcome and
version. Each matched field has its strategy, recorded update reason, retained
change flag and public value/provenance change flag. An older sequence can leave a
latest field unchanged while adding an entry to a history field. The report uses
those recorded reasons; it does not infer them from final values.

Duplicate recognition is a new attempt with no new field evaluation. Its receipt
may describe historical changes. An original-decision link is supplied only when
validated evidence identifies one matching application in the same state lineage:
SQLite restart preserves that lineage; memory restart resets it. Otherwise the
original detail is unavailable. A processing failure with no decision evidence
does not prove that state was rolled back.

The report also shows recorded actions, receipt deliveries, assertions and
lifecycle boundaries. Parent/cause references describe execution relationships,
not proof of a business-level cause. `--event` selects the named event, its explicit
ancestors and descendants, and associated publication decisions/receipts. Events
are never joined simply because their timestamps are close.

V1–V4 bundles remain readable, with an explicit “detailed reasons not recorded”
note. Other strategy families, timer/control decisions and internal storage
recovery receive observed-event summaries only. This command does not add
explanation endpoints, a browser UI or operational logging.

## Interpretation and limits

The `timeline-explanation/v1` JSON model contains the input manifest/trace hashes,
recorded profile and outcome, coverage, event references and `replayStatus: not-run`.
The text output renders that same model. Runtime counters are decimal strings,
so large publication sequences and versions remain exact. The same input and
report version produce stable bytes, without current timestamps or local paths.

Hash checks establish internal consistency, not authenticity. To verify fresh
execution, run [replay](timeline-replay.md) separately. Explanation reports live
outside the bundle and do not change its replay identity; report presentation
modules are also outside the executor's source identity.

No payload values are printed. Identifiers may still be sensitive, so a report is
not anonymised or automatically safe to publish. Terminal controls are escaped in
text. Reports are limited to 100,000 entries and 16 MiB; exceeding a bound fails
explicitly instead of truncating the explanation.

| Exit code | Meaning                                                         |
| --------- | --------------------------------------------------------------- |
| `0`       | Report written for a recorded passing scenario                  |
| `2`       | Report written for a recorded assertion failure or limit result |
| `1`       | Invalid/unsupported input, output limit or I/O failure          |

These exits describe the retained scenario result, not a new execution. Incomplete
bundles and infrastructure-failure prefixes cannot produce a complete explanation.
