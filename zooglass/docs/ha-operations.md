# Operating the bounded HA profile

`ha-static-v1` runs one active ZooGlass process with a takeover candidate sharing
its authoritative PostgreSQL state. A stable viewer address can route new
connections through HAProxy. This guide describes the topology exercised by the
[real-process fault harness](../../workbench/docs/ha-fault-harness.md); the retained
[finite qualification](../../workbench/docs/ha-qualification.md) passed on the
qualification branch and awaits integration review and merge.

The claim is service-process failover for the [supported static profile](postgresql-storage.md).
PostgreSQL and the proxy remain dependencies. This does not establish database HA,
proxy redundancy, physical-host availability, horizontal scaling or a production
recovery-time guarantee.

## Deployment topology

The fixture runs two ZooGlass JVMs, one PostgreSQL primary and one HAProxy process.
Both JVMs use the same runtime configuration, runtime ID, tenant and database schema.
Only the owner serves; its candidate reconstructs committed state after acquiring
a newer generation. The [fixture configuration](../../workbench/src/ha-fixture/configuration.ts)
and [pinned images](../../workbench/src/ha-fixture/images.ts) are the executable
reference for the tested setup.

Viewers use either two explicit direct HTTPS origins or one stable HTTPS origin.
HAProxy operates in TCP mode, passing TLS through to ZooGlass. The certificate on
each candidate must validate for the stable hostname and that candidate's direct
hostname. Clients trust the issuing CA; probes separately verify the candidate
certificate and hostname. Forwarded-header trust stays disabled.

In protected mode, each JVM has a trusted producer beside it. The producer reaches
only that JVM's loopback operator listener, using a separate operator credential.
The viewer proxy does not route `/events` to protected operator ingress. An
application moving a producer between machines must preserve its retained spool
and deliver it through an independently secured local producer arrangement.
The fixture's sidecars demonstrate this boundary; they are not a general remote
source adapter.

## Configure and start

1. Prepare the service artifact and select the admitted runtime JSON described in
   [service setup](ha-service.md#configure-candidates). Use identical artifacts and
   bindings on both candidates. Mixed-version rolling upgrades are not admitted.
2. Create a dedicated PostgreSQL database/schema and supply its credentials through
   deployment secrets. Keep a single writable primary. Use database TLS
   `verify-full` and configure its trusted CA. The fixture disables database TLS
   only inside its isolated Docker network; that is not a remote deployment recipe.
3. Configure viewer TLS and the [application policy settings](protected-deployment.md#configuration),
   then add the HA settings from the service guide. Its SQLite example is for
   standalone operation: this profile requires `storage: postgresql` and the HA
   database settings. Give readiness probes their own credential, distinct from
   viewer, operator and policy-service credentials.
4. Start both candidates with those settings. Check each direct `/ha/ready` route
   over verified TLS using its probe bearer token. A serving owner returns an empty
   200; an inactive, busy or uncertain process returns 503. Missing or invalid probe
   credentials return 401. Do not treat a process health response as serving readiness.
5. Start the proxy with the tested routing choices below. Connect an HA-aware client
   and require a fresh baseline before displaying data. In protected mode, verify
   that denied credentials cannot read snapshots and that the operator listener
   is unreachable from the viewer network.

The fixture's HAProxy template uses these settings:

| Choice                           | Tested value                                                    |
| -------------------------------- | --------------------------------------------------------------- |
| Data path                        | TCP TLS passthrough, HTTP/1.1 and WSS at ZooGlass               |
| Connect and health-check timeout | 2 seconds each                                                  |
| Client/server inactivity timeout | 35 seconds each                                                 |
| Proxy connection retries         | 0                                                               |
| Health request                   | Verified HTTPS `GET /ha/ready`, dedicated bearer token          |
| Healthy response                 | Exactly HTTP 200                                                |
| Probe cadence                    | 200 ms, three failures down, two successes up                   |
| Backend TLS verification         | Trusted CA, explicit `check-sni` and `verifyhost` per candidate |

Use the exact [template](../../workbench/src/ha-fixture/configuration.ts) to reproduce
these checks. Replace names, paths and secrets for your environment. Its admin
socket exists for fault injection inside an owned fixture; do not expose it to
clients or copy that control-plane exposure into a deployment. Do not put the
fixture's test agent, database gates, generated keys or test credentials into the
service deployment.

A proxy health decision can be stale. ZooGlass checks current authority before
admitting new output or mutations, so routing to an old process must result in
refusal rather than cache-only success. Previously permitted bytes can still
arrive after takeover. The HA client must discard obsolete results after it has
adopted the successor's baseline.

## Recover a service process

For planned handover, stop the current owner normally and let the candidate acquire
and recover. For an unexpected process loss, leave the candidate running against
the same database. Do not clear database ownership rows, change the runtime ID or
create a replacement empty schema to make it start.

Expect existing sockets to close or become unusable. The proxy does not move them.
The [reference client](../../workbench/docs/ha-client.md) reconnects, obtains fresh
policy decisions and installs a fresh baseline. Use its `clear` event to remove
unavailable data. A recovered owner has a higher generation within the same
incarnation; automatic recovery stops on a changed incarnation.

Restore redundancy after takeover: repair and restart the former candidate using
those same artifacts, configuration and authoritative database. Confirm that both
processes are reachable through authenticated readiness checks: the active owner
returns 200 and the recovered standby returns 503. Then verify a fresh client
baseline and continued updates through the intended direct or proxy route.
A reachable standby is not a second serving owner.

When a publication receipt is uncertain, retain its exact bytes, identity and
incarnation. Retry that operation through the new owner's appropriate ingress.
Do not give it a new sequence number merely because a connection failed.
`identityConflict` and `outsideRetention` require application reconciliation.
The application owns durable storage of unresolved work; the reference client's
in-memory retained value is not a durable spool by itself.

The fixture uses a 6-second lease, 2-second renewal and 150 ms acquisition retry,
with service retry jitter up to 250 ms. These differ from the service defaults.
The reference client allows at most five seconds per connection/protocol step
within a 30-second recovery episode. Exhausting that episode produces an
unavailable or unresolved outcome; it is not a promise that every failure recovers
within 30 seconds. Database locks, transactions, scheduling, policy availability
and proxy health all affect recovery. Whole-case harness duration includes setup
and cleanup and must not be reported as failover latency.

Recorded recovery intervals start at the termination request and end when the
harness confirms successor readiness or a fresh client baseline. They include
process-control and polling overhead, and any deliberate pauses in that run.
These are upper observations of those milestones, not exact callback timings or
an SLA.

## Diagnose unavailable service

| Observation                                          | Check and response                                                                                                                                                                                                                     |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Both direct readiness routes return 503              | Check database reachability, TLS, credentials and transaction availability; compare candidate settings with the persisted binding. Correct the cause, restart a stopped candidate and recheck readiness. Preserve authoritative state. |
| Direct readiness succeeds but proxy connections fail | Check proxy health status, probe token, CA and both hostname-verification settings. A failed TLS passthrough connection with no ready backend need not carry an HTTP 503.                                                              |
| Readiness returns 401                                | Fix the dedicated probe credential. Viewer or operator credentials are not substitutes.                                                                                                                                                |
| Protected viewer is refused                          | Check current policy decisions and viewer credentials. Reconnection does not transfer old grants; policy outage never permits open access.                                                                                             |
| Candidate refuses persisted state                    | Compare runtime ID, tenant, schema, canonical configuration and supported schema version. Restore compatible configuration, restart the candidate and recheck readiness rather than deleting or editing the state image.               |
| Producer remains unresolved                          | Preserve the original operation and incarnation, investigate the refusal and reconcile explicitly before discarding or repinning it.                                                                                                   |

When the database is unavailable, new commits and output permits stop. Restore
connectivity to the same authoritative database and allow a fresh acquisition and
recovery. There is no fallback to local memory or SQLite. Investigate repeated
ownership loss before increasing retry limits or relaxing timeouts.

The candidate loop does not currently log the underlying acquisition or recovery
failure. Absence of a log message is not evidence that a binding is compatible.
Permanent errors, including SQLSTATE classes 28 (authentication) and 42
(syntax/access rules), stop that loop until the JVM restarts. Correct database
access or configuration first, restart the candidate, then check readiness again.

Restoring an older backup is a different operation: stop writers, reconcile lost
acknowledged work and unresolved producer spools, and plan an explicit new runtime
incarnation and client reset. There is no automatic rollback, migration or
in-place reset procedure in this profile. Database replication, primary fencing
and durable promotion need their own qualified deployment.

## Reproduce and retain the evidence

Follow the [harness preparation and execution instructions](../../workbench/docs/ha-fault-harness.md#prepare-once-then-run).
Use a new output directory for each run. The finite campaign requires all fourteen
cases normally, all fourteen again with `--extra-pauses`, and both separately
prepared negative fence controls. A passing subset is not qualification. Test
execution uses prepared Java artifacts and never builds them.

Check each report's status, complete case inventory, prepared identities,
observation hashes and cleanup outcomes. Keep failed attempts when a correction
requires an affected-case rerun. Share only reviewed reports and observations;
fixture directories contain ephemeral credentials, private keys and database
files. Preserve the small evidence manifest and hashes in Git and larger bundles
as release assets. The fault cases use real processes and PostgreSQL; they do not
claim deterministic multi-node replay or statistical availability evidence.
