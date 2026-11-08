# Protected client acceptance

This check runs the basic vehicle demo against a real protected ZooGlass process.
Workbench supplies an HTTPS policy fixture, publishes positions through the local
operator socket and controls a TCP interruption without terminating TLS itself.
Chromium uses the demo's actual client and renderer.

From `workbench/`, with Java and the browser dependencies installed:

```sh
npm run prepare:service
npm run build:browser
node --import tsx --test test/browser/protected-access.test.ts
```

Prepare the service once after Java changes. The test starts the packaged service;
it does not build it. Test certificates are generated locally using `keytool` and
removed afterwards. Only the test browser context ignores their trust errors;
ZooGlass verifies the policy certificate using a dedicated test trust store.

## What it checks

- An allowed viewer receives positions and history. A denied subscription receives
  neither, even when the resource exists.
- Revocation, a credential-expired decision and an unavailable authority are
  exercised while source publications continue. Losing access closes the affected WSS connection with code 1008. The demo
  clears its position, history, route and marker, including hidden coordinates. Another allowed viewer continues
  receiving updates.
- A new connection while still denied cannot reuse an earlier grant. Once access
  is restored, a fresh authorised baseline supplies the latest position.
- Deliberate disconnection and abnormal network loss both clear protected data.
  Old socket callbacks cannot restore it or disturb a replacement connection.
- An explicitly armed recovery retries after the network returns. It waits for
  new baselines, rather than redisplaying cached positions.

The policy fixture supplies decisions, not snapshots. All displayed vehicle data
passes through ZooGlass's public publication and subscription interfaces.

## Client behaviour

The basic demo client accepts `{ protectedViews: true }` as its fourth argument.
Use a WSS endpoint and application-managed session cookies. This option connects
its `clearProtectedData` binding to the renderer's reset operation. The protocol
client stops accepting frames as soon as it closes or fails; the recovery wrapper
also ignores callbacks from superseded attempts.

The normal demo commands remain open demonstrations and retain last-known data
on interruption. This acceptance check exercises the protected variant without
adding login screens, session management or another browser orchestration system.
Applications remain responsible for their own rendering and cache cleanup. They
must not keep protected snapshots in diagnostic panels or persistent browser
storage after access loss.

See the [authorisation evidence map](../../docs/verification/authorisation.md)
for server-side scope, deadline and release-boundary checks.
