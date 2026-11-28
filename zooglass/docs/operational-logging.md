# Operational logs

The first logging slice covers service lifecycle, runtime configuration rejection,
storage loss, ingress processing and receipt-send failures. Delivery and access
logging are a subsequent slice; their existing records do not yet follow the
complete [logging design](../../docs/design/operational-logging.md).

## Read the service state

ZooGlass operational events use logger `io.zooglass.operations`. Each carries an
`event` and a process-local `instanceId`. Fixed fields describe the operation and
reason without dumping requests or exceptions. These records are best-effort
service diagnostics, not a durable security audit or publication ledger.

| Event                    | Meaning                                                                                              | Operator action                                                                                                                                       |
| ------------------------ | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `service.ready`          | Application setup succeeded; fields identify storage/access modes and configured source/view counts. | Check these modes match the deployment. Ready does not prove the fate of work from a previous process.                                                |
| `service.stopping`       | Shutdown began. Cleanup is not yet proven complete.                                                  | Check process exit and any subsequent cleanup failure. A killed process may emit nothing.                                                             |
| `service.start_failed`   | Startup failed before readiness.                                                                     | Check the deployment and configuration. Very early failures may precede logging setup.                                                                |
| `configuration.rejected` | Runtime registration could not be parsed or validated.                                               | Correct the submitted configuration using the configuration validation tools. Ordinary name conflicts remain HTTP 409.                                |
| `storage.unavailable`    | Persistence became unavailable and requires restart recovery.                                        | Stop sending new work, investigate the deployment/storage condition and recover through restart. Do not assume every interrupted request rolled back. |
| `storage.close_failed`   | Store cleanup failed.                                                                                | Check shutdown and storage condition; do not treat stopping as successful cleanup.                                                                    |
| `processing.failed`      | Unexpected failure while processing a publication or control.                                        | Inspect service health and surrounding lifecycle records. Keep the source receipt/retry contract as the authority for a publication.                  |
| `receipt.send_failed`    | Sending a receipt failed after processing.                                                           | Reconnect and retry according to the existing publication identity contract. The state may already be committed.                                      |
| `request.invalid`        | Input could not be parsed (DEBUG).                                                                   | Correct the request format; expected domain rejections remain in receipts and explanations.                                                           |

Storage-loss records describe the first unavailable transition. Later failures
from that unavailable store and health polling do not repeat the error. Other
repeated events are gated by fixed event/reason pairs: first occurrence immediately,
then at most one every 30 seconds. A later record includes `suppressed` when
occurrences were omitted. Quiet periods can leave a count unreported; these logs
are not complete event counts. Disabled levels do not consume the allowance.

## Console format and levels

Readable console output includes event fields. For structured console output, use
Spring Boot's supported option:

```sh
java -jar target/zooglass.jar --logging.structured.format.console=logstash
```

To enable ZooGlass operational DEBUG records, add:

```text
--logging.level.io.zooglass.operations=DEBUG
```

Logstash-format output places the operational values in JSON fields, alongside
framework timestamp, level and logger metadata. Custom log patterns or appenders
can omit fields or alter output; the supported defaults are the tested contract.
The configuration CLI's stdout and optional bound-port file remain separate
machine-readable interfaces. Do not discover readiness or a port by parsing logs.

## Privacy and limits

ZooGlass-owned operational records exclude payloads, resource identities,
credentials, URLs, filesystem paths and raw exception/cause text at every level.
DEBUG changes verbosity, not that field policy. Instance references identify a
process for log correlation; they do not replace publication identities or
[explanation evidence](../../workbench/docs/timeline-explanations.md).

Framework/vendor logs and user-installed appenders have their own policies,
particularly when Spring reports startup failure. This is not global redaction of
process output. Review deployment log access and retention, and avoid enabling
unrelated framework DEBUG logging without considering its contents.

Operational recorder failures must not replace protocol outcomes. Appenders can
block; runtime locks are not held during operational emission. Storage loss uses
one virtual thread per failed store, with no retry or queue. Shutdown does not
wait for this best-effort signal; it may be lost during abrupt exit. The controlled timeline and ordinary
runtime constructors default to a no-op recorder, without a logging clock or
worker; these logs do not enter semantic traces, replay hashes or configuration.
