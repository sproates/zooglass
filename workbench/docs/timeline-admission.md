# Prepared-artifact configuration inspection

From `workbench/`, after explicitly preparing the POC artifact:

```sh
npm run timeline:inspect -- admission scenarios/simulation/receipt-contract.json ../zooglass/target/zooglass.jar
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
capabilities, and `configuration: valid`. It still returns `execution: unsupported`:
the prepared fixed host advertises no general document formats, and Workbench has
no qualified general document executor. A syntactically valid document, valid
configuration and recognised artifact are necessary prerequisites, not proof that
the document ran or that its requested features are deterministic.

The ordinary `scenario`, `legacy` and `trace` inspection commands remain local
parsing/assessment operations and do not start Java. Saved artifact identity and
full verification replay are separate later work.
