# HA reference client

The integration branch provides a reusable Node.js client for the
[`ha-static-v1` service](../../zooglass/docs/ha-service.md). It reconnects with a fresh
baseline, rejects obsolete results and retries a producer's original publication
bytes when its receipt is uncertain. It runs against real service interfaces, not
the deterministic timeline. The [finite direct/proxy qualification](ha-qualification.md)
passed on its review branch; integration merge and main promotion remain pending.
Browser cross-origin operation is not claimed.

## Viewer

Run from a Workbench checkout with Node 26 and installed dependencies. Import the
client modules from `src/service/ha/` in a TypeScript application. For example:

```ts
import { readFile } from "node:fs/promises";
import { encodeJson } from "./src/json/lossless.js";
import { Ownership } from "./src/service/ha/ownership.js";
import { NodeTransport } from "./src/service/ha/transport.js";
import { HaViewer } from "./src/service/ha/viewer.js";

const origins = ["https://node-a.example:8443", "https://node-b.example:8443"];
const ownership = new Ownership();
const transport = new NodeTransport({
  origins,
  maxBytes: 65536,
  ca: await readFile("viewer-ca.pem"),
  bearer: process.env.VIEWER_TOKEN,
});
const viewer = new HaViewer({
  origins,
  ownership,
  transport,
  maxBytes: 65536,
  maxResources: 8,
  onEvent(event) {
    if (event.type === "snapshot") console.log(encodeJson(event.value));
    if (event.type === "clear") console.log("Clear the displayed view");
    if (event.type === "refused") console.log("Resource access refused");
  },
  onUnavailable(error) {
    console.error(error.message);
  },
});
await viewer.start([{ viewId: "match", entityId: "42" }]);
// Later, when the application stops:
await viewer.close();
```

Use a one-element `origins` array for a stable proxy address. The transport requires
verified TLS and explicit destinations; it neither follows redirects nor discovers
new endpoints. Its credential allowlist is fixed at construction. Supply an
`originHeader` only when the deployment's existing policy requires one.

`start` resolves after each requested resource has received a fresh baseline or
a refusal.
Subsequent `subscribe` calls return whether that resource was accepted. Await each
command before issuing another. `unsubscribe` resolves after acknowledgement.
A `refused` event removes that desired resource; other subscriptions continue.

`read(resource)` returns an exact snapshot, `null` for a checked unknown view, or
`undefined` when superseded or when a live subscription owns that presentation.
A configured view without data still has a normal empty snapshot. An old response,
including an old error or 404, cannot replace a newer presentation. An already
completed standalone HTTP read remains a point-in-time value; its application
decides when to refresh it. Handle `clear`
by removing displayed data whenever a connection retires or ownership becomes
uncertain. Keep callbacks synchronous and short.

## Producer and unresolved work

Create `HaProducer` with `origins`, `transport`, the **same** `Ownership` instance,
and `maxBytes`. `publish(bytes)` accepts one original JSON publication string;
a second publication is refused while the first remains unresolved. It returns
`{ status: "resolved", receipt }` or
`{ status: "unresolved", publication, reason }`. A resolved receipt may be a
rejection: inspect its status and reason.

For protected ingress, create a separate `NodeTransport` with an explicit
`http://127.0.0.1:<operator-port>` origin, `localOperator: true` and the operator
bearer token. Pass the same origins and `localOperator: true` to `HaProducer`.
This exception permits only producer `/events` traffic; it does not permit
plaintext remote viewer access. A protected remote application needs a trusted
producer beside the service or its own independently secured ingress arrangement.

The producer retains original bytes, identity and incarnation until the receipt
resolves the operation. `retry()` resends that retained operation; it never invents
a new identity. `identityConflict` and `outsideRetention` remain unresolved for
application reconciliation. `close()` stops activity without discarding retained
work. The application may save `producer.retained` and restore it through the
constructor's `retained` setting. Construct the shared `Ownership` with
`new Ownership(retained.incarnation)` when restoring pinned work; an unpinned or
differently pinned ownership object is rejected. Persistence of this spool is the
application's responsibility. Saved pins must be canonical lowercase UUIDs.

A changed incarnation stops every role sharing `Ownership`, clears the viewer and
preserves the producer's old pin and bytes. Do not silently repin an unresolved
publication to a replacement database. After explicit reconciliation the
application can discard it using `discardAfterReconciliation()` and construct new
clients with new ownership. Resetting a viewer does not reconcile a producer.

## Bounds and exact numbers

Defaults are five seconds per connection, hello, baseline, HTTP request or receipt
step, within a 30-second recovery episode. Retries rotate through the configured
origins with 250, 500, 1000 and 2000 ms backoff. A successful producer hello does not
restart its operation budget. Tests and applications may reduce `stepMillis` and
`episodeMillis`; they cannot increase these maxima. Authentication, certificate,
wire-format and incarnation failures stop automatic recovery. Subscription ordering
inconsistencies retire the connection and require a fresh baseline.

Configure `maxResources` and `maxBytes` explicitly. The transport queues at most
16 incoming frames and twice the per-frame byte limit, with a 16 MiB upper bound.
The exact JSON parser rejects duplicate members, invalid Unicode, depth above 64
and numeric text above 4096 digits. Numeric payloads use `Decimal`, retaining their
exact canonical numeric text; envelope counters are `bigint`. Use `encodeJson` rather than ordinary
`JSON.stringify` to emit those payloads without changing their numeric meaning.
There is no unbounded history or command queue.

## Verification

`node --import tsx --test test/ha-*.test.ts` covers ordering, shared incarnation
invalidation, stale responses, retained retries, limits and verified TLS. The
[service guide](../../zooglass/docs/ha-service.md#verify-locally) runs the client
against a prepared Java service and disposable PostgreSQL database. Test execution
never builds Java. The [retained fault campaign](ha-qualification.md) separately
checks direct and proxy failover. Neither these checks nor that campaign qualify
database or infrastructure HA.
