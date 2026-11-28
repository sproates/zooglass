# HA fault harness

The harness runs fourteen fixed acceptance cases against two real ZooGlass JVMs,
PostgreSQL and HAProxy. Node clients publish through the service and check receipts,
snapshots, generations and independently authored expected values. It does not
supply recovered state on ZooGlass's behalf.

A complete single run checks the harness implementation. It is not the later
[finite qualification](../../docs/design/clustering-high-availability.md#finite-qualification):
that requires all fourteen cases normally and again with additional pauses, plus
two negative fence controls and retained evidence. This guide does not record a
passing qualification or promise a production failover time.

## Prepare once, then run

Use JDK 25, Node.js 26, Python 3, OpenSSL and Docker. Install Workbench dependencies
with `npm ci`. Prepare Java explicitly from `zooglass/`, with no other Maven run
using that checkout:

```sh
./mvnw --batch-mode -DskipTests package
python3 scripts/prepare-ha-fault-agent.py
./mvnw --batch-mode dependency:build-classpath -Dmdep.includeScope=test -Dmdep.outputFile=target/ha-test-classpath.txt
python3 scripts/prepare-ha-controls.py --test-classpath target/ha-test-classpath.txt
```

The fault agent is needed for cases 3, 7 and 8. The two capture controls are
separate, non-serving Java test inputs. From `workbench/`:

```sh
npm run prepare:ha
npm run ha:verify
npm run ha:run -- --output /tmp/zooglass-ha-acceptance
```

Choose a new output directory for each invocation. `prepare:ha` compiles Node
modules and records their identities with the existing service JAR and fault
agent in `dist/ha-prepared.json`. Verification and execution refuse changed or
missing prepared inputs; they never build Java. Re-run explicit preparation after
changing those inputs.

For a focused repair check, use `--case 9` or `--cases 3,7,8`. A subset does not
establish that all fourteen cases pass. `--extra-pauses` enables the additional
bounded pauses used by the later qualification pass. Run the separate fence
controls from `zooglass/`:

```sh
python3 scripts/test-postgresql.py --ha-controls
```

The fixture uses the immutable image digests in
[`images.ts`](../src/ha-fixture/images.ts): PostgreSQL, JRE 25, Node 26 and HAProxy.
Docker must be able to obtain those images. Viewer and fixture-control host ports
bind to loopback. Each run creates its own network, containers, database and TLS
material; cleanup addresses only resources it owns.

## Fixed cases

The executable [manifest](../src/ha-cases/manifest.ts) freezes each case's
configuration, bounded barriers, expectations and access mode. Each case has a
180-second execution budget. “Protected” means `applicationPolicy`; “Open” means
`openDemo`.

| Case | Name                              | Access    | Viewer route | Main assertion                                                                                             |
| ---- | --------------------------------- | --------- | ------------ | ---------------------------------------------------------------------------------------------------------- |
| 1    | Simultaneous acquisition          | Open      | Direct       | One serving owner and empty initial state                                                                  |
| 2    | Orderly handover                  | Open      | Direct       | Same incarnation, retained view and original duplicate receipt                                             |
| 3    | Termination before commit         | Open      | Direct       | No false acknowledgement; same bytes commit once after takeover                                            |
| 4    | Commit with lost receipt          | Open      | Direct       | Retained bytes resolve to the original committed outcome                                                   |
| 5    | Acknowledged work survives        | Open      | Direct       | Fresh successor baseline preserves accepted state                                                          |
| 6    | Reachable former owner            | Open      | Direct       | Database-isolated owner refuses fresh output and writes                                                    |
| 7    | Write and output boundaries       | Open      | Direct       | Stale mutation fails; FIFO preserves capture 7 after commit 8; old callbacks cannot replace a new baseline |
| 8    | Paused lock holder                | Open      | Direct       | Server timeout releases the service's lock; expired owner cannot resume serving                            |
| 9    | State strategy recovery           | Open      | Direct       | Required contributions, hidden priority candidates and history survive                                     |
| 10   | Retention and binding refusals    | Protected | Direct       | Retention, conflicts, controls and incompatible bindings install no partial state                          |
| 11   | Protected reconnect               | Protected | Direct       | Fresh admission, policy refusal/outage and grant expiry do not leak snapshots                              |
| 12   | Backend recovery and cancellation | Protected | Direct       | Exact committed state survives database outage and candidate restart; cancellation cleans owned resources  |
| 13   | Stable origin, open               | Open      | Proxy        | Successor baseline, retained retry and continued updates; delayed results are discarded                    |
| 14   | Stable origin, protected          | Protected | Proxy        | Fresh admission, stale-health refusal, expiry, probe/TLS rejection and backend recovery                    |

Case 10 deliberately uses protected access to exercise an actual candidate tenant
mismatch. Case 13 selects `coalesceLatestState`; the other cases select
`disconnectOnOverflow`. The fixture covers the static profile's admitted field,
contribution and envelope-mapping strategies, not arbitrary runtime configurations.

Protected publications and retries use a trusted sidecar beside each JVM. It
connects to that JVM's loopback operator listener with a separate operator token.
Viewer credentials and HAProxy never grant source access. HAProxy passes viewer
TLS through to ZooGlass, validates its own authenticated readiness probes and does
not replay requests or migrate established sockets.

## Fault barriers and negative controls

The explicitly prepared test agent pauses real service calls before a write
check, while the service owns its PostgreSQL row lock, and around an output
permit. The harness observes those barriers before pausing or killing the named
JVM. Case 8 observes the actual service database backend and its blocked candidate;
it does not substitute a helper transaction for the service's lock holder.
The agent synchronises faults without weakening authority checks and is not a
production dependency.

The two negative controls are different: isolated, non-serving copies of
`PostgresAuthority.capture()` respectively omit owner matching and cache-revision
validation. Their independent real-PostgreSQL assertions must detect both faults.
They do not modify the service JAR, write path, renewal, readiness or handoff
checks. Passing ordinary service cases alone does not demonstrate that these
negative controls were detected.

## Read the results

The output contains `report.json`, per-case `observations.jsonl`, and owned fixture
logs and journals. Use the report to distinguish a complete run from a selected
subset, a failure or cancellation. Observations record receipts, snapshots and
fault barriers; prepared identities bind them to the executable inputs. Keep
fixture credentials and TLS private keys private when sharing evidence; publish
only reviewed, credential-free reports and hashes.

The harness checks service-process failover. It does not qualify redundant proxies,
PostgreSQL HA, host failure, browser cross-origin operation, throughput or
deterministic multi-node replay. See the [HA client](ha-client.md),
[service setup](../../zooglass/docs/ha-service.md) and
[wire contract](../../docs/design/ha-client-protocol.md) for their separate contracts.
