# Authorisation acceptance

ZooGlass checks application-owned permissions before reads and subscriptions,
then continues enforcing them while a subscription is open. This record maps the
[requirement](../requirements/authorisation.md) to repeatable checks.

Use the [deployment guide](../../zooglass/docs/protected-deployment.md) to run a
protected instance and the [policy protocol](../../zooglass/docs/access-policy.md)
to connect an application's authority.

## Requirement coverage

| Requirement | Evidence and observed outcome |
| --- | --- |
| Allowed access | [ProtectedDeploymentTests](../../zooglass/src/test/java/io/zooglass/access/ProtectedDeploymentTests.java) publishes through the operator socket and reads real HTTP/WSS views. [Workbench acceptance](../../workbench/test/browser/protected-access.test.ts) renders positions and subsequent updates in the basic demo. |
| Denied access | [ViewerAdmissionTests](../../zooglass/src/test/java/io/zooglass/access/ViewerAdmissionTests.java) checks missing credentials, unauthenticated decisions, denial and unavailable decisions on HTTP and socket admission. Errors contain no view data. Workbench checks a denied subscriber stays empty. |
| Resource and tenant isolation | `ViewerAdmissionTests.permissionForOneResourceCannotBeReusedByChangingIdentifiers` changes both entity and view IDs on HTTP and an already-authorised socket. Denied subscriptions cannot insert a baseline. [StoreTenantTests](../../zooglass/src/test/java/io/zooglass/runtime/StoreTenantTests.java) and `ProtectedDeploymentTests` reject a different tenant's database; grants do not select tenancy from client input. |
| Revocation during updates | Workbench keeps publishing while the authority denies one viewer. That viewer closes with 1008 and clears its display; another continues receiving updates. [NativeWssBackpressureTests](../../zooglass/src/test/java/io/zooglass/access/NativeWssBackpressureTests.java) observes actual transport submissions with an unread TLS peer and verifies queued data is suppressed after invalidation. |
| Expiry | [AccessStrategyTests](../../zooglass/src/test/java/io/zooglass/access/AccessStrategyTests.java) checks the five-second cap, shorter lifetimes and delayed replies. [GrantReleaseTests](../../zooglass/src/test/java/io/zooglass/access/GrantReleaseTests.java) rejects a handoff exactly at expiry without waiting for the timer. Workbench also exercises an authority declaring the viewer credential expired while publication continues. |
| Reconnect and restart | `ProtectedDeploymentTests` checks fresh decisions after restart in memory and durable modes; revoked access is not restored. Workbench checks refusal while still denied, a fresh baseline after permission returns, and normal/abnormal connection loss. Old callbacks cannot repopulate cleared data. |
| Decision failures and races | [AdmissionDeadlineTests](../../zooglass/src/test/java/io/zooglass/access/AdmissionDeadlineTests.java) expires grants during opening-message preparation. [ActiveViewGrantsTests](../../zooglass/src/test/java/io/zooglass/access/ActiveViewGrantsTests.java) covers outstanding renewal, expiry and superseded replies. [AuthorisedWriterTests](../../zooglass/src/test/java/io/zooglass/delivery/AuthorisedWriterTests.java) blocks taken or queued frames after invalidation. Workbench makes the authority return HTTP 503 during publication and observes clearing and recovery. |

## How the release bound is verified

A grant starts at the start of its policy request and lasts at most five seconds.
The authority must reflect a committed revocation in subsequent decisions and
limit grants to the remaining credential lifetime. A late reply cannot extend
that original deadline.

Controlled-clock tests establish the exact cutoff. They test the instant before
expiry and expiry itself, including a frame already removed from its queue.
The native WSS test separately establishes that transport backpressure does not
hold the grant monitor or delay an unrelated viewer. It delegates to the actual
asynchronous transport; it does not simulate send completion.

For HTTP, [AuthorisedHttpWriterTests](../../zooglass/src/test/java/io/zooglass/delivery/AuthorisedHttpWriterTests.java)
checks each bounded chunk. [HttpReleaseAcceptanceTests](../../zooglass/src/test/java/io/zooglass/access/HttpReleaseAcceptanceTests.java)
checks both routes over TLS: expiry before commitment, truncated output after
commitment, empty responses and an unread peer alongside a healthy reader.

Browser arrival time is not the release clock. Data handed to the transport
before cutoff can arrive later. Browser checks establish the visible access-loss
outcome independently by inspecting text, history, SVG paths and marker
coordinates; they do not substitute for the transport-boundary tests.

## Repeat the checks

From `zooglass/`, run the access and protected-writer suites:

```sh
./mvnw '-Dtest=io.zooglass.access.*Tests,Authorised*Tests,StoreTenantTests' test
```

Then follow [protected client acceptance](../../workbench/docs/protected-client-acceptance.md)
for the Workbench command. Prepare the service jar explicitly after Java changes;
the browser tests never build it. Do not rebuild a checkout while its tests are
using compiled classes or running service processes.

## Scope

- The verified deployment is one tenant per instance, direct HTTPS/WSS, HTTP/1.1
  snapshot reads and a separately authenticated loopback operator listener.
- The application's authority validates opaque credentials. ZooGlass does not
  implement an identity provider or interpret a token's expiry itself.
- The basic vehicle demo has an explicit protected mode. Normal open demos retain
  last-known data and are not examples of protected client behaviour.
- There is no replay interface. Cursor/replay authorisation remains a required
  acceptance check when replay is introduced, not a passed test today.
- ZooGlass cannot erase copies already made by a client. An application must clear
  its own caches and presentation when access is lost.

The current authorisation requirement has evidence across admission, ongoing
release, deployment, restart and client recovery. Cross-capability acceptance
combining reconciliation, shared inputs and restart is a separate programme item.
