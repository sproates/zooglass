# Application policy decisions

The application owns identity and permissions. ZooGlass sends the caller's opaque
credential and the requested resource to its policy service, then uses the result
to decide whether it may release a view.

This document defines the implemented policy client and strategy modules.
**Protected serving is not enabled yet.** HTTP and WebSocket admission, active
revocation and delivery checks follow the [accepted access contract](../../docs/design/view-access.md).
There are no public access configuration properties in this increment.

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

These are admission primitives. The next handlers must keep each socket bound
to one subject. Active delivery must separately check and invalidate grants,
discard superseded subscription generations and close connections on access loss.
The five-second end-to-end revocation contract depends on that enforcement too.
