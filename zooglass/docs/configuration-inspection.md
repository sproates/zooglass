# Check and explain a runtime configuration

Inspect an ordinary runtime v2 JSON file before starting ZooGlass. These commands
use the production decoder and validator, including strategy compatibility checks.
They do not start Spring, open SQLite, bind a port or contact an access-policy service.

Run from the repository root with a [prepared service JAR](../README.md#run-locally):

```sh
java -jar zooglass/target/zooglass.jar config check zooglass/docs/examples/configuration/orders-memory.json
java -jar zooglass/target/zooglass.jar config explain zooglass/docs/examples/configuration/sales-sqlite.json
```

`check` reports whether the configuration is valid and its storage choice.
`explain` also prints effective settings and a list of defaults applied. For sales,
that includes untracked progress, independent field contributions, accepted late
events, unspecified freshness, partial publication and fresh-snapshot recovery.
The configured fact revision, retention, projection modes and numeric property
remain visible alongside those defaults.

A successful check does **not** establish deployment validity, compatibility with
an existing database or admission to Workbench's deterministic timeline. SQLite
configuration can be checked without a database path. Use the existing deployment,
restart and timeline inspection procedures for those separate questions.

Only ordinary runtime JSON is accepted. Authored templates and `config expand`
remain proposed in [the authoring design](https://github.com/sproates/zooglass/pull/184).
Neither command modifies the input or writes an expanded file.

## Effective settings and defaults

The explanation shows the configuration after production decoding. Source and view
array order and source priority order remain intact. Field/entity maps are sorted
for presentation; single-element `inputs` becomes `sourceId`/`type` shorthand,
and required publication fields follow production sorting. These normalisations
are not labelled as default applications.

The runtime's compact `null` representation of independent field contributions
is displayed as `{"mode":"independentFields"}`. Other nulls describe unused
settings, such as the absence of progress bounds for untracked sources.
The effective object is an explanation, not a deployable replacement file.

Default entries use RFC 6901 JSON pointers **into the effective object**. Each entry
contains the value at that pointer. An omitted setting, or an explicit null that
production accepts as a default, is listed. An explicit equivalent policy is not.
A whole defaulted policy object is listed once; individual delivery defaults are
listed separately. All defaults come from production decoding. Inspection does not
introduce additional accepted nulls, infer update modes or select capacity limits.

## Script interface

Add `--json` after the filename. Standard output contains exactly one JSON report,
with no Spring banner or logs. Errors use the same report interface. Exit codes:

| Code | Meaning |
| --- | --- |
| 0 | Requested operation succeeded and configuration is valid. |
| 1 | Invalid input, unreadable file, tool limit or output failure. |
| 2 | Invalid command usage, including unsupported commands/options. |

A successful `check` report is:

```json
{
  "format": "zooglass-config-report/v1",
  "operation": "check",
  "inputFormat": "runtime/v2",
  "valid": true,
  "storage": "memory",
  "notChecked": ["deployment", "existingDatabaseCompatibility", "timelineEligibility"],
  "diagnostics": [],
  "explanation": null
}
```

All keys shown are always present. `operation` is the requested command, or null
when absent. Invalid reports have `inputFormat`, `storage` and `explanation` null;
no format is certified for rejected input. They have one diagnostic. Successful
`explain` replaces `explanation` with `{"effective": {...}, "defaults": [...]}`;
each default has `path` and `value`. Numeric values, including signed-64-bit delivery
bounds, are emitted exactly. Consumers needing exact large integers must use a JSON
parser that preserves them.

Each diagnostic has `code`, `path`, `reason`, `line` and `column`. Paths are JSON
pointers into the input document; the empty string means its root. Mapping errors
use parser-provided property/index context. Semantic errors currently identify the
root when no narrower structured context exists. Syntax locations are one-based
when available; otherwise `line` and `column` are null. The command's filename
identifies the input. Reasons help a person correct the file but are not stable
machine identifiers. Rejected values and raw parser exception text are not printed.

| Stable code | Meaning |
| --- | --- |
| `usage` | Expected `config check\|explain FILE [--json]`. |
| `input-io` | Input cannot be read as a regular file. |
| `input-too-large` | Input exceeds the tool's 16 MiB byte limit. |
| `invalid-encoding` | Input is not valid UTF-8. |
| `invalid-json` | Invalid JSON syntax, duplicate key or parser limit. |
| `invalid-value` | Property/type or record-constructor settings cannot be decoded, or a trailing document follows the configuration. |
| `invalid-configuration` | Production configuration validation rejects the settings. |

The command uses a bounded read and retains the production parser's depth, string,
number, Unicode and coercion restrictions. The 16 MiB limit belongs to this offline
tool; it does not introduce a new service input limit. Future authoring support will
extend this report version with documented optional expansion metadata rather than
changing the meaning of existing fields.
