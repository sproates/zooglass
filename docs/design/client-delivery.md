# Client delivery and recovery

**Proposed contract.** An application that subscribes to a view gets a current
snapshot, followed by full snapshots as the view changes. If its connection
breaks, it subscribes again. The first snapshot on the new connection replaces
whatever the application retained locally, including when the new snapshot is empty.

For example, a scoreboard disconnects at 2–1. While it is away, a goal is
withdrawn. On reconnect it receives 1–1 and can render it immediately. The
application needs neither the withdrawal event nor the intermediate scores.

## What a subscriber receives

Keep the existing subscribe request on `/views/live`. A successful subscription
produces these messages in order for the requested view and entity.

1. A `subscribed` acknowledgement names the view, entity and
   `"recovery": "freshSnapshot"`.
2. A `view-update` supplies the complete baseline. Its version, data, provenance,
   publication sequences and status have the same meaning as the HTTP snapshot.
3. Each subsequent update in that subscription has a greater version and contains
   the complete state at that version. A change in public status alone qualifies.

Capture the baseline, admit the subscription and enqueue its acknowledgement
and baseline under the coordinator lock, before a later commit can enqueue an
update. A commit racing subscription is either reflected in the baseline or
delivered afterwards. Network writes happen outside the lock.

A known view with no observed entity still sends a baseline at version zero,
with empty data and its actual status. A view waiting for required contributions
can have empty data at a positive version. Clients inspect status to distinguish
these cases. An unknown view or failed snapshot read returns an error and
creates no subscription. A connection lost before the baseline arrives must
subscribe again.

## Versions and reconnects

A version identifies the state of one view and entity within a running or
durably recovered store. Other entities can advance the shared revision counter,
so gaps between versions are normal. Every successful subscribe starts a new
subscription generation, including a repeated subscribe on the same connection.
Use the acknowledgement to begin waiting for its baseline. On reconnect, ignore
callbacks from the old connection and accept the new baseline even when its
version equals or precedes the last displayed version.

| Event | What the application sees |
| --- | --- |
| Viewer disconnects | Its retained display is last known. Other viewers continue. Subscribe again for a fresh baseline. |
| Source disconnects | The viewer stays subscribed. Configured source progress and freshness rules govern the retained value and its status. |
| ZooGlass restarts | Connections and subscriptions end. A durable store serves recovered state after readiness. A memory store can legitimately return an empty version-zero baseline. |
| History or facts expire while a viewer is away | The baseline contains the current retained window and its metadata. Retired facts and intermediate transitions cannot be requested by version. |

There is no replay window for subscriber messages. Reject an unsupported
recovery mode or a subscribe request with a replay cursor explicitly. An HTTP
read followed by a socket subscription comprises two independent operations.
The socket baseline is authoritative for that subscription.

## Slow clients

Configure delivery at service startup. Each connection owns one queue across
all its subscriptions, so it has one queue policy. The proposed defaults retain
the existing 128 waiting messages and disconnect behaviour, and introduce a
1 MiB waiting-byte budget per connection.

```json
{
  "delivery": {
    "recovery": "freshSnapshot",
    "slowClient": "disconnectOnOverflow",
    "maxQueuedMessages": 128,
    "maxQueuedBytes": 1048576
  }
}
```

An omitted delivery section uses these defaults. Reject unknown settings,
unsupported strategies and non-positive or fractional limits at startup.
Delivery settings apply to connections opened under that configuration. They
can change across restart independently of persisted view definitions.

Count the UTF-8 bytes of every queued message, including replies and baselines.
One write may already be in flight outside those waiting limits. Every individual
message must fit the byte limit. If one is too large, terminate the connection
with WebSocket close code 1009 when the transport permits. Retrying the same
oversized baseline requires a smaller view or a larger budget.

- **`disconnectOnOverflow`** preserves FIFO order. If the next enqueue would
  exceed either waiting limit, remove the connection’s subscriptions and request
  close code 1013. The client can reconnect and obtain a fresh baseline.
- **`coalesceLatestState`** may replace an unsent ordinary update for the same
  view, entity and subscription generation. Remove the older update and append
  the replacement at the tail. Preserve the initial baseline, acknowledgements,
  errors and in-flight writes. Apply both limits to the resulting queue.
  If it still exceeds either limit, use the same disconnect outcome.

An unsubscribe acknowledgement ends its generation. No update for that
generation may follow the acknowledgement. A broken or blocked transport can
prevent a close frame reaching the viewer. Loss of the connection is sufficient
to trigger resubscription. Neither policy changes a source receipt or another
client’s membership.

## Implementation and acceptance

The [current service](../../zooglass/README.md#live-subscriptions) already
coordinates subscriptions with commits and isolates socket writes. It sends an
initial update only for a positive version and bounds the waiting queue by
message count. The following slices extend those mechanisms.

1. Bind the recovery configuration to a named `FreshSnapshot` strategy. Include
   the mode in the acknowledgement and always deliver the baseline. Update
   Workbench and demo consumers to distinguish an acknowledged subscription from
   one that has received its baseline.
2. Bind the queue configuration to named `DisconnectOnOverflow` and
   `CoalesceLatestState` strategies used by each writer. Keep queue ownership,
   byte accounting and eviction local to the connection.
3. Verify the public outcomes with controlled races and real clients. Race a
   commit with subscribe, reconnect after missed corrections and retirement,
   restart both storage modes, and stall one of two viewers. Verify multibyte
   byte limits, oversized baselines, interleaved subscriptions and unsubscribe
   followed by resubscribe. Check the healthy viewer and source acknowledgements
   throughout. Use controlled writes for queue boundaries so OS buffer sizes
   cannot determine the expected result.
