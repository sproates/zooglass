# Order progress controls

Timeline v2 documents can select `runtime.profile: "sqlite-order-v1"` with
`storage: "sqlite"`, empty initial state and unprotected access. The prepared host
must advertise `sqliteOrder: 1` and accept the bounded
[Order configuration](timeline-order-host.md). Each run and replay uses a fresh
private database. This foundation supports progress transport; it does not yet
qualify the full Order demo or wall-clock adjustment. The separate
[`sqlite-order-restart-v1` profile](timeline-order-recovery.md) adds service restart
and requires `sqliteOrderLifecycle: 1` as well.

## Declare controls and observations

Declare an actor with `role: "progress"`, give it a `links` entry, then connect it
before sending a control. Actor IDs identify connections; the control's `sourceId`
identifies a configured source. They need not be equal.

```json
{
  "id": "confirm-orders",
  "atMs": 10,
  "kind": "progress-send",
  "actor": "progress",
  "control": {
    "sourceId": "orders",
    "epoch": "run",
    "sourceEntityId": "order-1",
    "throughSequence": 3
  }
}
```

Each `control` object retains exact JSON and is limited to 4,096 canonical UTF-8
bytes, matching the existing publication-input bound. Production `ProgressIngress` validates
it; malformed objects can deliberately exercise rejected acknowledgements. A
repeat is another explicit `progress-send` action with the same object. Controls
are not publications and cannot be targeted by source retry or receipt-loss rules.
There is no automatic control retry in this profile.

Use `kind: "control-receipts"` assertions on the progress actor. `expected` is the
complete ordered cumulative list delivered to that actor, including across
reconnects. It includes every watermark acknowledgement field: `kind`, `status`,
`reason`, `stream`, `throughSequence`, `version` and `changedViews`. An empty list
asserts that nothing has arrived. Source receipt and client frame assertions
remain bound to their respective actor roles.

Repeating the current committed watermark returns `duplicate/alreadyCommitted` with the
original version and no changed views. A malformed control returns
`rejected/invalidProgress` with null stream, sequence and version. Rejections are
real runtime outcomes; Workbench neither invents success nor calculates progress
state. SQLite processing failures remain infrastructure failures.

## Ordering, delay and disconnection

Controls execute as phase-two inputs, alongside publications and client requests.
Declaration order breaks ties between declared inputs. Connection lifecycle runs
in phase zero and runtime deadlines in phase one. Production expiry runs before
applying same-time input. This ordering is an explicit simulator convention; it
does not prescribe ordering across ordinary network sockets.

The actor's fixed one-way latency applies to both request and acknowledgement.
For example, latency 5 sends a control at time 10 to the runtime at 15; its
acknowledgement arrives at 20. Assertions at 19 and 20 can distinguish commitment
from acknowledgement delivery. Zero-latency returns use the existing next-round
callback convention.

Disconnection is abortive, as for the other [controlled links](timeline-links.md):

- Close before request arrival: the old request is discarded and cannot commit.
- Close after commitment but before acknowledgement arrival: the reply is
  discarded, but the committed watermark remains. An explicit repeat on a new
  connection receives the retained duplicate outcome.
- Close at an arrival timestamp: phase-zero closure wins over phase-two delivery.
  Reconnection never transfers queued packets to the replacement session.

Packets share existing pending-message, queue and turn budgets. No broader actor,
connection or trace bounds are introduced for this profile.

## Evidence and scope

The semantic trace records `progress-request` and `progress-receipt` links and
complete `control-receipt` effects, with actor, runtime and connection ownership.
The selected profile is retained in execution identity. Bundle verification and
replay preserve the scenario/configuration and compare freshly emitted records;
saved control responses are never fed back into execution. The existing strict
replay outcome policy applies.

Progress actors/actions/acknowledgements require the Order profile. Older profiles
and protocol-1 hosts cannot silently accept them. The ordinary `sqlite-order-v1` profile rejects
`service-stop`, `service-start` and `wall-clock-set`. The explicit recovery profile
admits stop/start and keeps wall adjustment rejected. Both profiles reject progress
sends during service downtime or without a live connection. A service stop cancels
in-flight requests and replies, including an abrupt stop without close callbacks;
a committed watermark survives even when its acknowledgement is cancelled.

Transport tests cover delayed acknowledgements, exact repeats, abortive closure,
malformed controls, admission boundaries and replay. The host tests separately
exercise multiple views/clients, gap status, source priority and required
contributions. The [ordinary two-cycle Order scenario](timeline-order-scenario.md) adds complete
independent receipts and named state/client observations. [Recovery](timeline-order-recovery.md) and [retention](timeline-order-retention.md)
have separate bounded fixtures. Repeated campaigns and ordinary-service parity remain later stages of the
[Order/Sports assessment](timeline-order-sports-assessment.md).
