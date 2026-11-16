# Check, explain and expand configuration

Inspect ordinary runtime v2 JSON or explicitly authored configuration before starting ZooGlass. These commands
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

`check` and `explain` accept ordinary runtime JSON or the explicit
`format: "zooglass-config/v1"` authoring format. They do not modify files.
`expand` accepts authored input only and writes a new ordinary runtime JSON file:

```sh
java -jar zooglass/target/zooglass.jar config expand zooglass/docs/examples/configuration/sales.authored.json --output /tmp/sales.runtime.json
```

Use a destination that does not exist. The command validates before writing and
never overwrites an existing file, including the input. Only use the output after
exit 0. On a handled failure, cleanup removes the output only if its filesystem identity
still matches the newly created file. If identity is unavailable or cleanup fails,
a failed output may remain. Use a directory you control; cleanup is not atomic
protection against concurrent directory mutation, and output is not crash-atomic. Pass the expanded file explicitly to the service or
Workbench. Neither consumer accepts authored documents or expands them implicitly.

### Local field templates

The complete [authored sales example](examples/configuration/sales.authored.json)
shares source/type and fact settings between `items` and `total`. Each use still
names its update mode, and `total` still names `amount`. Storage, epochs and root
capacity limits remain explicit. The [orders example](examples/configuration/orders-memory.json)
has no equivalent duplication and remains ordinary runtime JSON.

Templates may contain only `sourceId`, `type`, `inputs`, `conflict`, `late`,
`freshness` and `facts`. A reference contains only `use`, required `mode` and
optional `property`. No overrides are allowed, even with identical values.
Inline runtime fields may coexist with references. Every template must be used;
unknown names, unused templates, unknown keys, null template entries and nested
references fail. Names are local, exact and case-sensitive. There are no includes,
environment substitutions, expressions or inheritance. See the
[accepted design](../../docs/design/configuration-authoring.md) for the full grammar.

Expansion preserves declarations rather than filling in defaults. It sorts object
keys lexically, retains array order and emits compact UTF-8 JSON with one final
newline. Repeated runs with the same source/tool emit identical bytes. Changing a
template can change several runtime fields and can make a SQLite restart
incompatible; expansion does not migrate data or certify database compatibility.

For a complete check, expand, review and deploy sequence, see
[adopting local templates](configuration-authoring.md).

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

Add `--json` at the end of the command (after the destination for `expand`). Standard output contains exactly one JSON report,
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
no format is certified for rejected input. They have one diagnostic. Successful authored reports use `inputFormat: "zooglass-config/v1"`. Successful
`explain` replaces `explanation` with `{"effective": {...}, "defaults": [...]}`;
each default has `path` and `value`. Numeric values, including signed-64-bit delivery
bounds, are emitted exactly. Consumers needing exact large integers must use a JSON
parser that preserves them.

Each diagnostic has `code`, `path`, `reason`, `line` and `column`. Paths are JSON
pointers into the runtime input or authored grammar document; for authored
post-expansion validation they instead refer to the expanded runtime document,
with `origins` linking back to authored uses and templates. The empty string means
the relevant document root. Mapping errors use parser-provided property/index context. Semantic errors identify the source, view, field or entity context supplied by
production validation, with the root used when no narrower context exists. Syntax locations are one-based
when available; otherwise `line` and `column` are null. The command's filename
identifies the input. Reasons help a person correct the file but are not stable
machine identifiers. Rejected values and raw parser exception text are not printed.

| Stable code | Meaning |
| --- | --- |
| `usage` | Invalid operation or options; `expand` additionally requires `--output NEW_FILE`. |
| `input-io` | Input cannot be read as a regular file. |
| `input-too-large` | Input exceeds the tool's 16 MiB byte limit. |
| `invalid-encoding` | Input is not valid UTF-8. |
| `invalid-json` | Invalid JSON syntax, duplicate key or parser limit. |
| `invalid-value` | Property/type or record-constructor settings cannot be decoded, or a trailing document follows the configuration. |
| `invalid-configuration` | Production configuration validation rejects the settings. |
| `invalid-authoring` | Authoring grammar or local reference error. |
| `authoring-required` | Expansion was requested for ordinary runtime input. |
| `expanded-too-large` | Substituted output exceeds 16 MiB. |
| `output-exists` | The output destination already exists. |
| `expansion-io` | Input/output or prepared-JAR identity cannot be accessed for expansion. |

The command uses a bounded read and retains the production parser's depth, string,
number, Unicode and coercion restrictions. Input and expanded output each have a 16 MiB limit. Substituted bytes are bounded
before the complete expanded tree is parsed. These limits belong to this offline
tool; it does not introduce a new service input limit. Authored reports add an `origins` array. Each entry has `path` (expanded field),
`usePath`, `templatePath` (both in the authored input), and `settings` (the names
inherited from the template). Explicit mode/property remain use-site declarations.
For runtime validation failures, `origins` includes only references at the failing
field; nonfield failures have no matching origins. Authoring grammar errors point
directly into the authored input. Defaults still refer to the effective object.

Successful expansion also adds `expansion` with `inputSha256`, `outputSha256` and
`toolJarSha256`, each a lowercase hexadecimal SHA-256. The tool hash identifies the
actual running prepared production JAR; expansion is unavailable when that artifact
cannot be identified. Input/output hashes cover exact bytes and are consistency
checks, not signatures or semantic-equivalence hashes. Check/explain do not require
packaged-JAR identity. Existing runtime-only reports retain their original fields.
