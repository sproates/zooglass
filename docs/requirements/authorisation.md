# Authorisation over time

Status: the [enforcement contract](../design/view-access.md) is accepted. Server-side
admission, active revocation, transport-release checks and protected deployment
are implemented. Real-interface tests cover isolation and recovery. Workbench
and demo access-loss acceptance remains outstanding, so the full requirement
is not yet signed off. See the [deployment guide](../../zooglass/docs/protected-deployment.md).

A live view can remain open for hours. Someone who was allowed to see it when
it opened may lose that permission while updates are still arriving. ZooGlass
must enforce access throughout the life of a view subscription, including
recovery after a connection failure.

For example, an operator may be allowed to follow one fleet's vehicles but not
another fleet's. Removing that access must stop further delivery to the active
subscriber. Reconnecting or presenting an old recovery cursor must not restore
access that has been withdrawn.

## Required behaviour

- ZooGlass must establish the caller's identity and permitted scope before
  returning protected view data. Missing, invalid or expired credentials, or
  an unavailable permission decision, must not grant access.
- Permission checks must cover HTTP snapshots, live subscriptions, reconnects
  and any future replay interface. Possession of a view identifier or recovery
  cursor is not permission to read its data.
- Access must be scoped to the requested resource and tenant where tenancy is
  used. A caller authorised for one scope must not receive another scope's data.
- Revocation and expiry must stop delivery on existing subscriptions within a
  documented, finite bound. The contract must define the start of that bound,
  the enforcement point and how queued or in-flight data is handled. Once the
  cutoff is reached, ZooGlass must not release further protected payloads to
  that subscriber.
- The client must receive an observable access-loss outcome. The supplied demo
  app must stop presenting the affected view as live and clear its protected
  display state. ZooGlass cannot erase data a client has already received or
  copied; the delivery guarantee must state that boundary.

The permissions policy belongs to the integrating application or its identity
and policy services. ZooGlass is responsible for applying that policy to its
own reads and deliveries. This requirement does not select an identity provider,
policy engine, token format or role model.

## Evidence required for completion

Workbench scenarios must exercise the real service interfaces and observe both
allowed and denied requests. UI behaviour alone is insufficient evidence.

| Scenario | Required observation |
| --- | --- |
| Allowed access | A permitted caller receives the expected snapshot and subsequent updates. |
| Denied access | Missing, invalid and expired credentials, and an authenticated caller without permission, receive no protected payload. |
| Scope isolation | A caller permitted for one resource or tenant cannot read or subscribe to another, including by changing identifiers. |
| Revocation during delivery | With updates continuing, revoke access and measure the last protected delivery against the specified cutoff. Observe access loss in the client. |
| Expiry during delivery | Let access expire on an open subscription; verify the same bounded cessation and client outcome. |
| Reconnect and recovery | Reconnect after access loss, including with a previously valid cursor when replay exists. No protected data is returned unless current permissions allow it. |
| Decision failure and races | Make permission checking unavailable and race revocation with snapshot setup and queued updates. Verify the documented denial and delivery-bound rules. |

Replay checks become mandatory when replay is introduced; they must not be
reported as passed while that interface is absent. Browser scenarios must also
inspect the rendered access-loss state independently of the app's own reports.

## Enforcement contract

The [proposed design](../design/view-access.md) defines the policy boundary,
cutoff and client outcome. Completion requires implementation and the repeatable
observations above.
