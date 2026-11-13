# Prepared-artifact configuration inspection

From `workbench/`, after explicitly preparing the POC artifact:

```sh
npm run timeline:inspect -- admission scenarios/simulation/receipt-contract.json ../zooglass/simulation-host/target/zooglass-simulation.jar
```

This inspects admission prerequisites, not scenario execution. It reads the strict
versioned document and its referenced configuration (relative to the document),
checks the configuration's SHA-256 against the exact file bytes, then starts the
prepared Java artifact solely to validate configuration. Files must be regular,
valid UTF-8 and at most 16 MiB. This command never builds Java.

The artifact's handshake identifies its actual SHA-256 and its admission protocol.
The unstarted host invokes the **same configuration mapper, decoder and validators**
as ordinary ZooGlass startup. It creates no coordinator, store, subscriptions or
scheduled work. Its configuration storage/version must agree with the document.
A missing hash match, unsupported artifact, invalid configuration or disagreement
fails inspection. Strategy validation is not reimplemented in TypeScript.

A successful report contains the artifact hash, configuration hash, required
capabilities, the decoded configuration profile, and `configuration: valid`.
It reports `execution: eligible` when the prepared artifact advertises the document
format and the configuration/document fit the [bounded executor](timeline-execution.md).
Otherwise it reports `execution: unsupported` with a reason. Neither is an execution
result: runtime-derived connection closure or an incorrect expected observation can
still fail an eligible run.

The ordinary `scenario`, `legacy` and `trace` inspection commands remain local
parsing/assessment operations and do not start Java. The separate [verification replay](timeline-replay.md) command re-executes saved
versioned runs within its explicit identity/environment boundary.
