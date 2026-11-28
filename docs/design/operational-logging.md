# Operational logging

Status: accepted design. The foundation implementation is proposed in the current
PR; delivery and access logging remain pending.

An operator should be able to tell whether ZooGlass started with the intended
operating modes, why it stopped serving useful work, and whether a fault requires
a client reconnect, a dependency check or a service restart. Routine publications
must not bury those signals. This is a bounded service-logging change, not a new
telemetry platform or a performance-optimisation programme.

## Current behaviour and scope

The service already uses SLF4J through Spring Boot. Ingress failures generally
report only an exception class, but some delivery/subscription paths log arbitrary
exception messages or a Throwable. Viewer connects/disconnects currently log at
INFO. SQLite failure removes storage availability until restart, while health
polling only returns UP/DOWN. Access decisions already distinguish unauthenticated,
denied and unavailable outcomes; logs should preserve those distinctions.

Keep the existing logger implementation and ordinary Boot level controls.
Use fixed event names and explicitly supplied SLF4J key/value fields. Keep readable
console output as the default; document Boot's optional JSON console format and
verify both with the project's pinned dependencies. No custom JSON encoder,
collector, file-retention service, audit ledger or mandatory remote exporter.
[Boot logging reference](https://docs.spring.io/spring-boot/reference/features/logging.html)

[Event explanations](event-explanations.md) answer why a particular publication
changed a view. Operational logs answer what is happening to the service. Do not
copy payloads, decision trees or all successful receipts into logs, or imply that
log retention provides replay evidence. Workbench's semantic traces remain unchanged.

## Event contract

Each ZooGlass operational record has `event`, `reason` when relevant, and a fixed
message explaining the consequence. Event/reason values come from a finite code
catalogue, not exception text or request values. Optional context is explicitly
listed below. Each production record carries the same process-local `instanceId`.
The logging framework supplies timestamp, level and logger.

| Event                                     | Level | Trigger and useful context                                                                                                                                                                                                    |
| ----------------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `service.ready`                           | INFO  | Once after application readiness; storage/access modes, configured source/view counts, process-local `instanceId`. No full configuration.                                                                                     |
| `service.stopping`                        | INFO  | Once when shutdown begins for a ready service. Cleanup may still fail.                                                                                                                                                        |
| `service.start_failed`                    | ERROR | Service startup fails before readiness. Record a known stage or `unexpected` at the application startup boundary. Early failure can precede logging initialisation.                                                           |
| `configuration.rejected`                  | WARN  | Runtime view registration fails parsing or validation. A valid name conflict is an ordinary 409 response. The startup event owns startup rejection.                                                                           |
| `storage.unavailable`                     | ERROR | First healthy-to-unavailable transition after install or registration failure; operation, `restartRequired=true`. Not emitted for each later request or health poll.                                                          |
| `storage.close_failed`                    | ERROR | Owned store close fails; safe failure category. Does not change the existing cleanup/error propagation contract.                                                                                                              |
| `processing.failed`                       | ERROR | Unexpected publication/progress/retirement failure; operation and safe failure category. Never asserts rollback or absence of a committed effect.                                                                             |
| `receipt.send_failed`                     | WARN  | Receipt transport fails after processing; opaque connection reference if available. State may already be committed; a retry follows existing receipt semantics.                                                               |
| `delivery.failed`                         | WARN  | Preparing an opening/update, notifying a listener or completing a requested transport close fails. Record the stage. A failure after installation does not establish rollback.                                                |
| `delivery.close_requested`                | WARN  | The delivery owner requests a close after a frame is too large, queue admission returns FULL, or a write fails. FULL also covers a stopped queue. The actual close callback is separate.                                      |
| `access.unavailable`                      | WARN  | An admission or renewal decision returns `UNAVAILABLE`. Record operation and transport. Timeout, malformed response and capacity exhaustion can all produce that outcome. Grant loss alone does not identify a policy outage. |
| `access.refused`                          | DEBUG | Existing unauthenticated/denied outcome; transport and reason only. Not a security audit trail.                                                                                                                               |
| `request.invalid`                         | DEBUG | Malformed wire input or unsupported request shape; operation and fixed reason. Expected domain rejections remain in receipts/explanations.                                                                                    |
| `connection.opened` / `connection.closed` | DEBUG | Opaque connection reference, transport and fixed close category. No remote address or supplied close text.                                                                                                                    |

Freeze the exact catalogue and reason enums in the first implementation slice.
Rows describe required operator outcomes; avoid duplicate events from nested
catch blocks. The component that makes the operational decision owns its record.
If a storage transition is already recorded, ingress must not emit an additional
ERROR for that same failure or flood errors for subsequent restart-required work.
Unclassified genuine failures use `unexpected`, never a fabricated specific cause.

Readiness follows successful store initialisation and runtime setup. Both a fresh
SQLite store and a restored store can reach ready. A ready event cannot establish
the fate of an earlier publication. Spring's context-closing notification precedes
bean destruction. Emit `service.stopping` there and report storage close failure
at its owner. The application has no proof of a successful whole-process shutdown
at either boundary. A forced exit can prevent any final record.

## Context and privacy

Use a small typed operational-record helper with a closed field set. The fields
are event, reason, stage, operation, failure category, transport, storage and
access modes, instance and connection references, configured source/view counts,
`restartRequired` and the suppression count. Each event admits only its documented
subset. The helper accepts neither arbitrary maps nor objects for serialisation.

Generate `instanceId` per process and connection references locally. They are
log correlation aids, not credentials, client-controlled IDs or replay identities.
Store a connection reference with the owned session and discard it on cleanup;
no permanent session registry or per-entity logging map. Pass context explicitly
across executors; do not depend on uncleared thread-local MDC. These references
can join records within one run but do not replace the publication identity in
receipts or explanation artifacts.

At every ZooGlass log level, exclude payloads, entity/source/view/tenant/subject IDs,
credentials, grants, tokens, headers, complete URLs, query strings, database paths,
configuration bodies, remote addresses and raw exception messages. Do not attach
Throwables, causes or suppressed exceptions to operational records. Use a finite
failure category (storage, transport, serialization, policy, unexpected).
DEBUG uses the same field restrictions.

This contract covers ZooGlass-owned records. Spring, the servlet container, JDBC,
and user-supplied appenders have their own logging behaviour, especially during
startup failure. Do not claim that this change redacts every framework log. Test
representative full-process failures for accidental leakage and document precisely
which output is covered. Configuration validation errors must not be copied into
new logging fields. Keep the machine-readable `config` CLI stdout and the optional
bound-port file usable by existing callers. Neither depends on parsing logs.

## Bounded volume and ownership

No successful publication, duplicate, progress update, snapshot read or health
poll emits an INFO record. Routine connection churn is DEBUG. Repeated invalid
requests, dependency unavailability and delivery/processing failures are gated by
fixed `(event, reason)` buckets, shared across connections. No bucket key contains
an identity, URL, exception message or arbitrary input.

For each bucket, emit the first occurrence immediately and at most one subsequent
record per 30 seconds, including the number suppressed since the last emission.
Use an injected monotonic clock and saturating counters; no timer thread is needed.
If traffic stops, a summary waits until another occurrence. A quiet bucket may
end with an unreported count. No shutdown flush is required. Finite catalogue
size bounds memory and emission rate. DEBUG
records use the same gates. One-time lifecycle records and the first storage-loss
transition are not hidden by a noisy bucket.

Check level and gate before constructing optional context. Disabled events consume
no bucket allowance. Gate admission and suppression-count extraction must be atomic
for each key. Logging failure must
not replace a receipt outcome, change committed state, reopen a closed session or
prevent cleanup. Guard the operational helper against appender RuntimeExceptions
without recursively logging that failure. Do not catch fatal JVM Errors or add an
unbounded async queue. An appender can block. Keep calls to appenders outside the
coordinator, grant and queue monitors, including listener and writer-failure
paths that already hold the coordinator monitor. Where an outer owner can emit
after releasing a lock, carry only the small, typed outcome to that boundary.
If a callback has no such boundary, defer only a bounded, best-effort signal;
specify its overflow and close behaviour in that slice. A slow sink must not
hold up other threads acquiring these monitors. Operators own sink rotation and
retention.

Keep the logging clock independent of receipt, freshness and controlled timeline
clocks. Ordinary Java callers and the controlled host use a no-op recorder by
default. It performs no wall-clock read, allocates no correlation IDs and starts no worker.
Production service wiring owns its recorder. Neither recorder state nor emitted
identifiers enter receipts, configuration identities, replay hashes or semantic
traces.

## Implementation boundaries

A cohesive `io.zooglass.logging` package owns the catalogue, typed emission and
bounded suppression. Lifecycle wiring owns application events. Existing runtime,
delivery and access components emit at the boundary that owns each failure or
transition. Keep storage transitions identifiable without parsing exception
messages; introduce a narrow typed signal if required, preserving existing public
protocol outcomes. Do not redesign persistence, transport queues or access policy.

Use the current logging configuration surface (`logging.level.*` and Boot's
structured console option). No new runtime scenario fields, tracing endpoint,
publication correlation header, live log viewer or service metrics subsystem.
The human console pattern must include the key/value fields, and JSON mode must
emit them as fields rather than a JSON string inside `message`. Custom patterns
can omit fields; document the supported defaults and operator override limits.

## Delivery and acceptance

One design PR and two implementation PRs. Each implementation slice delivers its
own tests, relevant source-map changes and operator guidance.

1. **Lifecycle, storage and processing.** Introduce the typed catalogue, Boot
   output configuration and finite suppression. Cover startup, shutdown, runtime
   registration, storage loss, ingress processing and receipt delivery. Use a
   prepared-service smoke for healthy startup/shutdown and invalid configuration.
   Fault fixtures cover storage loss, cleanup failure and a failed receipt send
   after installation. Check the exact owner and multiplicity, health transitions,
   receipt bytes and retry semantics. Exercise the no-op path in an existing
   controlled timeline replay.
2. **Delivery, access and operator guidance.** Replace the existing delivery and
   subscription log calls, including exception text and attached causes. Cover
   queue admission, write/listener failure, access refusal and unusable policy
   decisions. Check existing close codes, grants and HTTP outcomes. Exercise a
   protected request and viewer lifecycle through public entry points. Use
   deterministic fixtures for forced closure, expiry and concurrent failure
   bursts. Complete the operator guide with a troubleshooting action for each
   failure. Review the service log call sites for privacy after this slice.

Use realistic capture appenders and owned-process output, not assertions against
helper implementation details alone. Check readable text and JSON rendering on
the pinned Boot version. A burst fixture spanning many sessions must show bounded
warning/error output with correct suppression accounting and fixed-cardinality
bucket state. Use an appender blocked on a latch to check another thread can
acquire the coordinator during a delivery failure, without a throughput test.
Check disabled levels, counter saturation and a throwing appender. Test hostile text in
payloads, credentials, close reasons, exception causes and nested errors, including
newlines, in both output formats. Assert bounded record sizes from the closed
field set. Regression cases should fail against the previous leaking/noisy path
where practical. Tests use prepared artifacts and never invoke a Java build.

Finish when the event catalogue is implemented, the bounded fixtures and process
smokes pass, independent review is clear and the guide tells an operator what to
do with each failure. Additional collectors, metrics, security auditing, distributed
correlation and further performance qualification are separate decisions.
