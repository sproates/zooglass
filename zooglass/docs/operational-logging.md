# Operational logs

Operational logs cover service lifecycle, configuration rejection, storage loss,
processing, delivery and access decisions. They follow the bounded
[logging design](../../docs/design/operational-logging.md).

## Read the service state

ZooGlass operational events use logger `io.zooglass.operations`. Each carries an
`event` and a process-local `instanceId`. Fixed fields describe the operation and
reason without dumping requests or exceptions. These records are best-effort
service diagnostics, not a durable security audit or publication ledger.

| Event                                     | Meaning                                                                                              | Operator action                                                                                                                                       |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `service.ready`                           | Application setup succeeded; fields identify storage/access modes and configured source/view counts. | Check these modes match the deployment. Ready does not prove the fate of work from a previous process.                                                |
| `service.stopping`                        | Shutdown began. Cleanup is not yet proven complete.                                                  | Check process exit and any subsequent cleanup failure. A killed process may emit nothing.                                                             |
| `service.start_failed`                    | Startup failed before readiness.                                                                     | Check the deployment and configuration. Very early failures may precede logging setup.                                                                |
| `configuration.rejected`                  | Runtime registration could not be parsed or validated.                                               | Correct the submitted configuration using the configuration validation tools. Ordinary name conflicts remain HTTP 409.                                |
| `storage.unavailable`                     | Persistence became unavailable and requires restart recovery.                                        | Stop sending new work, investigate the deployment/storage condition and recover through restart. Do not assume every interrupted request rolled back. |
| `storage.close_failed`                    | Store cleanup failed.                                                                                | Check shutdown and storage condition; do not treat stopping as successful cleanup.                                                                    |
| `processing.failed`                       | Unexpected failure while processing a publication or control.                                        | Inspect service health and surrounding lifecycle records. Keep the source receipt/retry contract as the authority for a publication.                  |
| `receipt.send_failed`                     | Sending a receipt failed after processing.                                                           | Reconnect and retry according to the existing publication identity contract. The state may already be committed.                                      |
| `delivery.failed`                         | Preparing or delivering a view failed; the reason identifies the stage.                              | Check transport and service health. A failure after state installation does not imply rollback.                                                       |
| `delivery.close_requested`                | Delivery requested a close; this is not confirmation that the connection closed.                     | Reconnect and request a fresh snapshot. Queue FULL may mean a stopped writer, not just a slow viewer.                                                 |
| `access.unavailable`                      | Admission or renewal returned an unavailable decision.                                               | Check the policy service and deployment. Timeout, unusable replies and local capacity can all cause this outcome; the log does not identify which.    |
| `access.refused`                          | Access was unauthenticated or denied (DEBUG).                                                        | Check credentials and policy through the application's authorised support process. No credentials or subject IDs are logged.                          |
| `connection.opened` / `connection.closed` | A viewer connection opened or its actual close callback ran (DEBUG).                                 | Use the locally generated connection reference for within-process correlation. Close reasons are fixed categories, never peer-supplied text.          |
| `request.invalid`                         | Input could not be parsed or used as a supported request (DEBUG).                                    | Correct the request format; expected domain rejections remain in receipts and explanations.                                                           |

Storage-loss records describe the first unavailable transition. Later failures
from that unavailable store and health polling do not repeat the error. Other
repeated events are gated by fixed event/reason pairs: the first occurrence is
eligible immediately, then at most one every 30 seconds. A later record includes `suppressed` when
occurrences were omitted. Quiet periods can leave a count unreported; these logs
are not complete event counts. Connection events share those gates, so the logs
do not contain a complete connection inventory. Disabled levels do not consume the allowance.

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
DEBUG changes verbosity, not that field policy. Instance and locally generated
connection references support within-process log correlation; they do not replace publication identities or
[explanation evidence](../../workbench/docs/timeline-explanations.md).

Framework/vendor logs and user-installed appenders have their own policies,
particularly when Spring reports startup failure. This is not global redaction of
process output. Review deployment log access and retention, and avoid enabling
unrelated framework DEBUG logging without considering its contents.

Operational recorder failures must not replace protocol outcomes. Appenders can
block; runtime locks are not held during operational emission. Storage loss uses
one virtual thread per failed store, with no retry or queue. Shutdown does not
wait for this best-effort signal; it may be lost during abrupt exit.

Delivery callbacks that hold runtime locks defer only a fixed-category signal and
an optional locally generated reference. One lazy virtual worker handles one
in-flight record and at most one pending cell per event/reason; repeated signals coalesce with saturating
counts. A slow sink can delay other deferred records, but cannot grow the queue
with connections or payloads. Shutdown discards pending records without waiting
for a blocked sink. If the worker cannot start, deferred signals are disabled
for that recorder; direct records remain available. Coalesced occurrences beyond
the emitted representative count towards the next eligible suppression summary.
These signals are best-effort, not a shutdown audit.

The controlled timeline and ordinary runtime constructors default to a no-op
recorder, without a logging clock or worker; these logs do not enter semantic traces, replay hashes or configuration.
