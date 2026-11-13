# Fixed virtual link delay and interruption

Every actor's required `links` entry has `latencyMs`, an integer from 0 to 3,600,000.
It is a fixed **one-way** delay, applied independently in both directions of each
connection generation:

- Source publication to runtime, then runtime receipt back to source.
- Client subscribe/unsubscribe request to runtime, then acknowledgement, error or
  view frame back to client.

For example, a source latency of 3 ms makes a publication sent at virtual 10 ms
reach ZooGlass at 13 ms and its receipt reach the source at 16 ms. Receipt-age
freshness starts at runtime ingress, 13 ms. A client latency of 4 ms adds another
4 ms between a completed runtime frame and that actor's observation.

The [delayed-links example](../scenarios/simulation/delayed-links.json) independently
checks those times, the initial subscription round trip and the resulting expiry:

```sh
npm run timeline:execute -- scenarios/simulation/delayed-links.json /tmp/delayed-links.json
npm run timeline:replay -- /tmp/delayed-links.json /tmp/delayed-links-replay.json
```

These commands use the prepared JAR and never build it. Virtual delays do not sleep
for that duration on the host. Added bridge pauses/pacing do not change the semantic
trace. Positive-latency payloads remain lossless through ingress, observation and replay.

## Connection ordering and closure

Each direction preserves FIFO within its generation. Fixed latency and agenda order
keep same-time sends in order; reconnects receive separate queues. Zero-latency links
retain the existing inline request handling and next-round return delivery semantics.
Connect/disconnect are local lifecycle actions, with no simulated handshake delay.
A root disconnect at a delivery timestamp runs in phase zero before phase-two arrival.

Interruption models an **abortive close**, not graceful stream drainage; FIFO
describes delivery within a surviving generation, not delivery guarantees after
closure. Closing the real connection immediately cancels all queued positive-latency packets
in both directions and records their exact envelopes, message IDs and close causes.
Pending counts fall immediately, so a run may finish before their original delivery
times. Old publications that never reached runtime do not commit. Publications that
already committed stay committed; a fresh-generation retry receives the real retained
identity outcome. Queued old subscription requests cannot affect a replacement
session. Existing zero-latency callbacks observe the closed generation and drop in
their already scheduled causal round.

A `link-send` record includes `messageId`, `channel`, `envelope` and `deliverAtMs`.
The four channels are `source-publication`, `source-receipt`, `client-request` and
`client-frame`. `delivered` or `dropped` records retain the message identity and exact
envelope. Drop causes link the original send and actual connection close; selected
receipt loss also retains its fault decision. Replay compares these records as they
are emitted during fresh execution.

## Receipt deadlines and budgets

Managed receipt deadlines start at source send/enqueue, so they include both outward
and return transit. With immediate reconnect on every timeout:

- Timeout shorter than outbound delay can prevent every attempt reaching runtime.
- Timeout between ingress and return can commit once, lose every return, and exhaust
  while subsequent attempts remain duplicates.
- A retry wait long enough for the current receipt permits that receipt to cancel
  the queued retry without another connection or send.

At a positive round-trip deadline tie, phase-one timeout precedes phase-two receipt
arrival. Nonfinal timeout queues a cancellable retry; final timeout fails immediately,
as in the [retry contract](timeline-retries.md). A timeout consistently shorter than
round trip is not expected to recover automatically under unchanged settings.

Delayed packets share the pending-message bound with existing arrival callbacks and
held writer frames, and share the agenda queue/turn bounds. Model callback IDs are
allocated centrally, so packet cancellation cannot cancel a receipt timer. End
`pendingMessages` includes queued packets; `pendingFutureTasks` counts runtime and
retry timers separately, not packet callbacks. Even allowing future tasks cannot
permit queued messages in a successful result. A horizon may precede a packet's
scheduled delivery, but that packet must be explicitly invalidated or the run fails.

This models fixed transport transit, not writer backpressure: writer handoff completion
and actor arrival are distinct. Use explicit writer stalls for writer/queue behaviour.
Per-message variable delays, jitter, directional stalls, timed partitions and physical
TCP behaviour remain outside this qualification. Interruption here uses declared
lifecycle closes, receipt-loss closes or retry-driven replacement connections.
