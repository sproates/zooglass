# Running the HA service profile

The integration branch adds `ha-static-v1`: one active ZooGlass process and takeover
candidates sharing one PostgreSQL primary and runtime schema. Each response is
checked against database ownership. The service and Node reference client are
implemented here. The [real-process fault harness](../../workbench/docs/ha-fault-harness.md)
adds isolated two-JVM and HAProxy acceptance checks; finite recorded deployment
qualification remains outstanding. This is not a production HA certification or a
horizontal scaling capability.

Read the [supported static profile](postgresql-storage.md) and
[wire contract](../../docs/design/ha-client-protocol.md) first. Standalone service
configuration and existing demo protocols retain their meaning.

## Configure candidates

Use the same runtime configuration, runtime ID, tenant and database schema on every
candidate. The runtime JSON selects `"storage":"postgresql"`. A minimal example is:

```json
{
  "contractVersion": 2,
  "storage": "postgresql",
  "maxStreams": 6,
  "identityWindow": 2,
  "maxHistoryEntries": 2,
  "sources": [{ "id": "feed", "epoch": "run" }],
  "views": [
    {
      "id": "match",
      "fields": {
        "score": {
          "sourceId": "feed",
          "type": "updated",
          "mode": "latestBySequence"
        }
      }
    }
  ]
}
```

Provide these deployment settings through Spring configuration or environment
variables. Keep passwords and tokens outside version control and command history.

| Setting                                          | Requirement or default                                                                    |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `zooglass.deployment.profile`                    | `ha-static-v1`                                                                            |
| `zooglass.config`                                | Resource location of the runtime JSON                                                     |
| `zooglass.access.mode`                           | Explicit `applicationPolicy` or `openDemo`                                                |
| `zooglass.ha.runtime-id`                         | Stable, nonblank identity shared by candidates                                            |
| `zooglass.ha.database-url`                       | `jdbc:postgresql://host:5432/database`, without credentials or connection options         |
| `zooglass.ha.database-user`, `database-password` | Database credentials                                                                      |
| `zooglass.ha.database-schema`                    | Optional existing schema; otherwise the database default                                  |
| `zooglass.ha.database-ssl-mode`                  | `verify-full`; explicit `disable` is available for an isolated test database              |
| `zooglass.ha.probe-token`                        | Separate 32–512 character bearer secret, distinct from operator and policy service tokens |
| `zooglass.ha.lease-ms`                           | 15000; supported range 1–300000                                                           |
| `zooglass.ha.renew-ms`                           | 5000; positive and shorter than the lease                                                 |
| `zooglass.ha.retry-ms`                           | 1000; positive, at most 300000; retries add up to 250 ms jitter                           |
| `server.ssl.enabled`                             | `true`, with the viewer certificate and key store configured                              |
| `server.forward-headers-strategy`                | `none`                                                                                    |
| `server.http2.enabled`                           | `false` (the default)                                                                     |

Database TLS uses pgJDBC's verified certificate and hostname validation. Configure
its trusted root certificate for the service account. Viewer TLS is independently
required in both access modes. Do not expose an `openDemo` deployment to untrusted
clients: it deliberately has no application policy boundary.

For protected deployments, retain the existing [application access settings](access-policy.md).
Viewer traffic uses TLS and fresh policy admission. `/events` remains on the
separately authenticated loopback operator listener. Remote producers therefore
need a trusted local process or an independently secured path to that listener;
this profile does not expose operator ingestion through a public proxy.

Unknown HA settings, standalone storage overrides, unsupported runtime profiles,
forwarded-header trust, a separate management listener or remapped management
routes fail startup. Conflicting persisted runtime bindings prevent activation.
Changing the stored incarnation is not an automatic recovery operation.

## Connect and check readiness

Use the [Node reference client](../../workbench/docs/ha-client.md), or implement
explicit HA negotiation and recovery from the wire contract. Ordinary clients must
not silently consume HA responses as standalone snapshots.

`GET /ha/ready` on the viewer TLS listener requires its dedicated bearer token.
A successful check returns an empty, non-cacheable 200. A busy, inactive or
uncertain owner returns 503; missing or incorrect credentials return 401. This
check has a two-second deadline and cannot queue behind another owner operation.
An expired check retires its uncertain attempt rather than releasing a late 200.
Neither ordinary process health nor a proxy's cached health decision authorises
application output.

A future qualified proxy deployment will use TCP TLS passthrough and this readiness
check. Keep clients configured for one explicit stable origin or two explicit direct
origins. No redirects, discovered endpoints or proxy-level publication retries are
part of this contract.

## Verify locally

Prepare Java once, then run tests without builds:

```sh
# From zooglass/
./mvnw --batch-mode -DskipTests package
python3 scripts/test-postgresql.py
# After npm ci in workbench/, using the same prepared JAR:
python3 scripts/test-postgresql.py --node-client
```

Each script invocation owns a pinned disposable PostgreSQL container and removes
only that container and its volumes. The first command checks storage, ownership,
protected TLS transport, readiness contention and HTTP grant cutoffs. The Node
check uses the actual packaged service over TLS for baselines, updates, exact large
numbers, HTTP snapshots and retained duplicate receipts. These focused checks are
not the later fault campaign or a throughput benchmark.
