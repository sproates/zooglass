# Bounded HA qualification

This campaign checks whether the `ha-static-v1` profile preserves accepted state,
rejects stale owners and recovers clients through direct and stable proxy addresses.
It uses two real ZooGlass JVMs, PostgreSQL and HAProxy on one Docker host.

Status: all 28 executions and both negative controls passed on 28 November 2026.
The tested harness checkpoint is `c8886597b0a684d5e811f757c63560faf9e7eed7`.
The qualification changes await integration review and merge; main promotion
remains separate. See the [retained evidence manifest](../evidence/ha-static-20261128.md).

| Pass                    | Cases passed | Observations | Extra pause events | Process pause occurrences |
| ----------------------- | -----------: | -----------: | -----------------: | ------------------------: |
| Normal                  |      14 / 14 |           91 |                  0 |                         0 |
| Additional 75 ms pauses |      14 / 14 |          121 |                 30 |                        48 |

All 28 cases verified removal of their owned resources. The six production/control
outcomes detected exactly the two intended invariant violations. The offline audit
passed. One preliminary run was deliberately interrupted during case 5, after four
passes, to add recovery timing before the final freeze. Its interruption and
verified cleanup are retained separately; it is not one of the 28 final executions.

The host was macOS arm64, with Node 26.0.0 and Docker Engine 29.5.2 running Linux
arm64 containers. The manifest pins PostgreSQL 18.7, JRE 25, Node 26 and HAProxy
3.2.27 image digests. This is one local environment, not a fleet of independent
machines or a cross-platform availability qualification.

## Scope and interpretation

The [frozen case manifest](../src/ha-cases/manifest.ts) defines fourteen cases. Each
runs normally and again with deliberate 75 ms process pauses. Two separate,
non-serving capture controls omit owner or cached-revision validation; their six
production/control observations must expose exactly the two intended violations.
The [harness guide](ha-fault-harness.md#fixed-cases) maps cases to configurations,
access modes, transport and fault boundaries.

The scenario assertions check authored state, receipts, generations, refusal and
client recovery against the real service. The offline auditor checks completeness,
prepared identities, observation hashes, pause evidence, measured boundaries and
negative-control outcomes. Individual run reports retain `qualification: false`: a
single run is not the aggregate qualification. It does not rerun the semantic assertions or prove the
absence of every possible defect. Hashes establish consistency, not authenticity.

The cases cover service-process faults while PostgreSQL and the proxy remain the
authoritative dependencies. They also check bounded database outage/recovery and
stale proxy health, but do not qualify database promotion, redundant proxies,
physical-host failure, horizontal scaling, arbitrary runtime configurations or
browser cross-origin deployment. The fixture uses verified viewer/probe TLS and
an isolated plaintext database network. Remote database TLS deployment is not
qualified by this run. This is real-process fault testing, not deterministic
multi-node timeline replay or an availability benchmark.

## Recovery measurements

`takeover` observations measure from the termination request through the harness's
confirmation that a different owner has a higher generation and the same
incarnation. The stable-origin observation measures through confirmation of the
successor's client baseline. Both include process-control, scheduling, polling and
any injected pause. The client may receive its baseline before the harness checks
it. These are observed confirmation durations, not precise client downtime or
production recovery-time guarantees. Whole-case duration includes fixture setup
and cleanup and is reported separately.

Selected observed confirmation durations are below; every recorded timing is in
`audit.json`. These few observations describe this run and do not establish a
latency distribution.

| Boundary                                                       |   Normal | With extra pauses |
| -------------------------------------------------------------- | -------: | ----------------: |
| Orderly handover to confirmed successor readiness              |   637 ms |          1,034 ms |
| Open stable origin to confirmed successor client baseline      | 8,155 ms |          8,152 ms |
| Protected stable origin to confirmed successor client baseline | 8,255 ms |          6,241 ms |

Case 7 observed retirement of the already-permitted frame. The two proxy cases
separately checked rejection of deliberately delayed HTTP results and old
WebSocket callbacks after the successor baseline. This does not claim that the
network delivered a previously permitted frame in every run.

## Reproduce

Follow [explicit preparation](ha-fault-harness.md#prepare-once-then-run), including
the service JAR, fault agent and capture controls. Freeze the manifest and prepared
identity before running, keep source/artifact inputs unchanged between passes, and
use new output directories. From `workbench/`:

```sh
node --input-type=module -e 'import {faultCases} from "./dist/ha-cases/manifest.js"; console.log(JSON.stringify(faultCases, null, 2))' > frozen-manifest.json
cp dist/ha-prepared.json frozen-prepared.json
npm run ha:run -- --output /tmp/ha-normal
npm run ha:run -- --extra-pauses --output /tmp/ha-paused
python3 ../zooglass/scripts/test-postgresql.py --ha-controls
python3 scripts/audit-ha-qualification.py /tmp/ha-normal /tmp/ha-paused \
  --manifest frozen-manifest.json --identity frozen-prepared.json \
  --controls ../zooglass/target/ha-fence-controls
```

The controls command runs prepared tests; it does not compile Java. Each top-level
case has a 180-second execution budget. Failure requires investigation and an
explicit affected-case rerun, not repeated attempts until one happens to pass.

For deployment and recovery procedures, use the [operator guide](../../zooglass/docs/ha-operations.md).
Keep fixture directories private: they contain credentials, keys and database
files. Only reviewed public reports, observations and preparation manifests belong
in retained release evidence.

Public copies replace only the prepared service and fault-agent path values with
project-relative paths. The publication-transform record gives original and public
file hashes; observations and their hashes are unchanged. Private fixture data and
executable JARs are excluded. The archived auditor works without the original
checkout, but re-running service cases requires the matching prepared environment.
