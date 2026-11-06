# Application policy decisions

The application owns identity and permissions. ZooGlass sends the caller's opaque
credential and the requested resource to its policy service, then uses the result
to decide whether it may release a view.

This document defines the policy client, admission handlers and active grant lifecycle.
**Protected serving is not enabled yet.** Admission is exercised through internal
test wiring; final transport-release checks follow the
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
retain their grants in memory and renew them during source silence. The five-second
end-to-end contract also requires the final transport checks described below.

## HTTP and WebSocket admission

Both snapshot routes ask for a resource decision before looking up the view.
They return 401 for missing or invalid credentials, 403 for denial and 503 when
a decision is unavailable. Only an allowed lookup can reveal a 404. Protected
responses carry `Cache-Control: no-store`. Snapshot admission checks the grant
again after preparing the result; per-chunk transport checks are still pending.

A socket authenticates before upgrade. Its subject and selected credential stay
with that connection. Each subscription asks for a fresh decision outside the
coordinator lock, then checks the grant when admitting its acknowledgement and
baseline together. Expiry during message preparation refuses admission.

An inactive subscription failure sends `accessDenied` or `accessUnavailable`
without a baseline. A failure for an already-active subscription removes all
memberships and queued messages and closes that socket with code 1008. A changed
subject also closes it. Other sockets remain independent. Final checks for a
frame already taken by the writer belong to active delivery enforcement.

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

This lifecycle is wired into subscription admission and cleanup. It does not yet
check frames already taken by the writer or HTTP chunks at final transport
handoff. Those checks remain necessary before enabling protected startup; a timer
alone does not establish the release cutoff.
