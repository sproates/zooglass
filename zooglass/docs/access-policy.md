# Application policy decisions

The application owns identity and permissions. ZooGlass sends the caller's opaque
credential and the requested resource to its policy service, then uses the result
to decide whether it may release a view.

This document defines the policy client, admission handlers and active grant lifecycle.
**Protected serving is not enabled yet.** Admission is exercised through internal
test wiring; protected deployment wiring still follows the
[accepted access contract](../../docs/design/view-access.md).

Startup accepts `zooglass.access.mode=openDemo` (the default). Selecting
`applicationPolicy` fails startup until active enforcement is complete. Unknown
modes and protected settings supplied in open mode also fail, so a configuration
mistake cannot silently enable an unprotected service.

## Strategies and settings

`AccessStrategySelection` selects `OpenDemoAccess` or `ApplicationPolicyAccess`.
Open demo access needs no credential and returns an explicit open decision.
Application policy returns either a scoped grant or an authentication, denial or
availability failure. There is no fallback to open access on a policy failure.

The internal `PolicySettings` value contains:

| Setting | Rule |
| --- | --- |
| Tenant | Required, fixed by the deployment. No surrounding whitespace. |
| Endpoint | An absolute HTTPS URL, without user information, query or fragment. |
| Service token | Required bearer token used to authenticate ZooGlass to the policy service. |
| Timeout | Between 1 millisecond and 5 seconds, covering the complete response body. |
| Concurrent calls | Between 1 and 256. Excess calls fail as unavailable without queuing. |

The client verifies the server certificate and hostname using Java's TLS trust
configuration. It never follows redirects and performs no application-level
retries. Shutdown cancels outstanding calls. Replies are limited to 16 KiB,
including chunked responses. Credentials and reply bodies are excluded from
error messages and logging.

## Requests

ZooGlass sends `POST` with `Content-Type: application/json`. Its service token is
in the `Authorization: Bearer ...` header. The viewer credential is in the JSON
body, separate from the service token.

A resource decision looks like this:

```json
{
  "operation": "read",
  "tenant": "tenant-a",
  "credential": { "type": "bearer", "value": "opaque-viewer-token" },
  "resource": { "viewId": "orders", "entityId": "42" }
}
```

An identity-only request uses `"operation": "authenticate"` and omits `resource`.
A session cookie uses credential type `"session"`. The endpoint must validate the
credential on every request. The caller cannot choose the tenant or subject.
View and entity IDs retain their exact decoded values, as used for snapshot lookup.

The credential reader accepts one bearer header or one configured session cookie.
Unrelated cookies are ignored. Multiple bearer headers, repeated session cookies,
or supplying both forms are rejected. Tokens are at most 4096 characters and use
letters, digits, `.`, `_`, `~`, `+`, `/` or `-`, with optional trailing `=` padding.
Session values are unquoted. Missing credentials are rejected without a policy call.

## Replies

Return HTTP 200 with `Content-Type: application/json` and exactly one of:

```json
{ "decision": "allow", "subject": "operator-7", "lifetimeMillis": 5000 }
```

```json
{ "decision": "unauthenticated" }
```

```json
{ "decision": "deny" }
```

`unauthenticated` means the viewer credential is invalid or expired. `deny` means
the authenticated caller is not permitted to perform the requested operation.
The policy service must see committed permission changes on subsequent decisions.

An allow needs a nonblank subject of at most 1024 characters and a positive integer
lifetime that fits a signed 64-bit value. The authority must limit that lifetime
to the remaining credential and permission lifetime. ZooGlass caps it at five
seconds. Unknown fields, duplicate fields, trailing JSON, invalid types or values,
non-200 responses and transport failures all produce an unavailable decision.
A service-authentication HTTP 401 is therefore not mistaken for a viewer failure.

## Grants

The strategy starts the grant's monotonic clock **before** making the policy
call. Time spent waiting consumes its lifetime. An allow that arrives after the
deadline is discarded. A grant is invalid at the deadline, not after it.

A read grant records the configured tenant, returned subject and exact requested
view/entity. An identity-only grant cannot authorise any resource. Decisions are
not cached, and concurrent responses stay attached to their own requests.
Grants exist only in memory.

The admission handlers keep each socket bound to one subject. Active subscriptions
retain their grants in memory and renew them during source silence. Socket delivery
checks the current grant again at transport handoff.

## HTTP and WebSocket admission

Both snapshot routes ask for a resource decision before looking up the view.
They return 401 for missing or invalid credentials, 403 for denial and 503 when
a decision is unavailable. Only an allowed lookup can reveal a 404. Protected
responses carry `Cache-Control: no-store`. Snapshot admission checks the grant
again after preparing the result; the HTTP writer checks it at each chunk handoff.

A socket authenticates before upgrade. Its subject and selected credential stay
with that connection. Each subscription asks for a fresh decision outside the
coordinator lock, then checks the grant when admitting its acknowledgement and
baseline together. Expiry during message preparation refuses admission.

An inactive subscription failure sends `accessDenied` or `accessUnavailable`
without a baseline. A failure for an already-active subscription removes all
memberships and queued messages and closes that socket with code 1008. A changed
subject also closes it. Other sockets remain independent. Denial invalidates the
grant before delivery cleanup can wait for the coordinator. The writer checks
frames already taken from the queue as well as those still waiting.

The internal protected viewer listener requires direct TLS and an allowed
browser Origin. Cookie-based socket handshakes must provide that Origin;
non-browser bearer clients may omit it. Forwarding headers cannot substitute
for connector TLS evidence. The viewer listener excludes publication, progress,
retirement, registration and management routes. A handler-level check also blocks
management endpoints relocated beneath the viewer URL prefix.

Protected deployment remains gated on active enforcement and an isolated
operator path. A trusted TLS-terminating proxy will also need explicit backend
isolation and forwarding-header handling before it is supported; the current
admission fixture does not enable that deployment option.

## Active subscriptions

`ActiveViewGrants` tracks one grant per resource and connection. A repeat
subscription creates a new generation; renewal replies for replaced or removed
generations are discarded. Unsubscribe, disconnect and shutdown release this state.
No grant is restored from storage.

`GrantRenewals` checks every 25 milliseconds and starts renewal halfway through a
grant's original lifetime. Policy I/O runs outside the registry and coordinator
locks, with at most 32 concurrent renewal calls and no waiting work queue. The
policy client's own concurrency and timeout limits still apply. If renewal
capacity is unavailable, the affected socket loses access rather than retaining
an unchecked grant.

Expiry, denial, authentication failure or an unavailable renewal invalidates all
of that socket's grants and closes it with code 1008. A renewal cannot change the
subject, tenant or resource. Socket cleanup is dispatched separately after grant
invalidation, so waiting for the coordinator cannot block renewal or expiry for
other viewers. An allow arriving after the old grant expired cannot
revive the connection, even if the expiry sweep has not run yet. Other viewers
keep independent grants.

## Protected WebSocket release

Every acknowledgement, baseline and update carries its connection and subscription
generation. Connection-level replies also require the connection's active grants
to remain current. Replacement and unsubscribe discard obsolete waiting frames;
frames already taken by the writer are checked again before submission.

The writer uses Jakarta WebSocket's asynchronous text submission. Under the grant
monitor, it checks connection membership, generation and deadlines, then submits
the frame. Invalidation uses the same monitor. A successful renewal updates the
grant used by frames already queued for that generation; a replaced generation
cannot borrow its successor's grant. A lease cannot authorise another connection.

Release means handing the complete text frame to the transport, not its eventual
arrival at the client. The writer waits for send completion outside the grant and
coordinator monitors, with only one frame outstanding per socket. Data already
handed to the transport before cutoff may arrive later. Unsupported transport
adapters cannot fall back to a blocking protected send.

A native-WSS regression uses a real TLS peer that stops reading after upgrade.
It observes a large frame remaining outstanding, queues a later update, then
revokes access. It checks that invalidation completes, no later frame is submitted,
a healthy viewer continues receiving updates and the stalled connection is cleaned
up. Transport probes forward to the real Jakarta implementation; they do not
simulate send completion.

## Protected HTTP release

Both snapshot routes serialise the result into application-owned bytes before
starting nonblocking servlet delivery. The writer waits for transport readiness,
checks the request's scoped grant, then submits at most 8 KiB. Returning from the
controller is not the release point. Bytes accepted by the transport before the
deadline may arrive afterwards.

HTTP reads use their original grant without renewal. If it expires before success
headers are committed, the response is an empty 503: ZooGlass no longer has a
current decision. The initial policy decision still distinguishes 401, 403 and
503. An authorised 404 is also checked at release.

After commitment, expiry discards the remaining bytes and aborts the transport.
The declared content length lets clients detect an incomplete snapshot. The
Tomcat adapter closes the connection or resets the stream rather than completing
it normally; there is no blocking-write fallback. Clients must discard incomplete
responses. Write readiness and network waits never hold the view coordinator.
A five-second async timeout also cleans up a client that never resumes reading.

Tests control the grant clock before the first chunk and between chunks. Real
HTTPS tests check an empty failure before commitment, truncated delivery after
commitment, and an unread TLS peer causing native backpressure while another
viewer continues reading.

Protected deployment wiring remains outstanding. Startup stays disabled until
the isolated operator path and deployment acceptance are complete.
