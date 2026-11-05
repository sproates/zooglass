# Client delivery and recovery

**Delivery contract.** An application that subscribes to a view gets a current
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
update. A racing commit either contributes to the captured state or queues an
update after the baseline, subject to the connection’s queue policy. A FIFO
viewer can receive the baseline at version 1 followed by versions 2 and 3.
A coalescing viewer can receive versions 1 and 3 if version 2 was still waiting.
Network writes happen outside the lock.

For a known view, version zero means the store has no retained revision for that
view and entity. Its baseline contains empty data and the actual status.
Otherwise send the retained revision, even if its data is empty. For example,
advancing a fact-retirement floor before the first publication creates a positive
revision. Its baseline includes that floor and the input still says `notObserved`.
A view waiting for required contributions can also have empty data.

An unknown view or failed snapshot read returns an error and
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
| Facts retire while a viewer is away | The baseline contains the remaining facts and the retirement floor. |
| A source publication identity expires | Accepted history entries still appear in the baseline. Once ordered history reaches its capacity, ZooGlass rejects new entries with `historyLimit`. |

There is no replay window for subscriber messages. Reject an unsupported
recovery mode or a subscribe request with a replay cursor explicitly. An HTTP
read followed by a socket subscription comprises two independent operations.
The socket baseline is authoritative for that subscription.

## Slow clients

Configure delivery at service startup. Each connection owns one queue across
all its subscriptions, so it has one queue policy. The default FIFO policy allows
128 waiting messages and 1 MiB of waiting UTF-8 payload per connection.

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
unsupported strategies and invalid limits at startup. Both limits must be positive
integers. The message limit must be at least two to admit a subscription’s
acknowledgement and baseline together.
Delivery settings apply to connections opened under that configuration. They
can change across restart independently of persisted view definitions.

Count the UTF-8 bytes of every queued message, including replies and baselines.
One write may already be in flight outside those waiting limits. Every individual
message must fit the byte limit. If one is too large, terminate the connection
with WebSocket close code 1009 when the transport permits. Retrying the same
oversized baseline requires a smaller view or a larger budget.

Admit the acknowledgement and baseline as a pair. Under the queue lock, reserve
two waiting slots and their combined UTF-8 bytes before exposing either message
to the writer. If the pair alone exceeds the byte budget, request close code
1009. If the pair fits an empty queue but other waiting messages leave too
little room, request 1013. In either case, enqueue neither message and remove
the connection’s subscriptions. Both policies use this rule.

- **`disconnectOnOverflow`** preserves FIFO order. If the next enqueue would
  exceed either waiting limit, remove the connection’s subscriptions and request
  close code 1013. The client can reconnect and obtain a fresh baseline.
- **`coalesceLatestState`** keeps only the newest waiting ordinary update for each
  view, entity and subscription generation. On every ordinary update, remove
  its waiting predecessor if present, then append the new update at the tail. Preserve the initial baseline, acknowledgements,
  errors and in-flight writes. Apply both limits to the resulting queue.
  If it still exceeds either limit, use the same disconnect outcome.

An unsubscribe acknowledgement ends its generation. No update for that
generation may follow the acknowledgement. A broken or blocked transport can
prevent a close frame reaching the viewer. Loss of the connection is sufficient
to trigger resubscription. Neither policy changes a source receipt or another
client’s membership.

## Implementation and acceptance

Real WebSocket tests disconnect a scoreboard, correct one goal and retire another.
When the scoreboard reconnects, its first snapshot contains the corrected goal
and the retirement floor. The next live update matches the source receipt.
The tests restart the service with each storage mode and check the new baselines,
including a match whose only revision records a retirement floor.

Controlled writers exercise the queue boundaries below. Workbench also pauses a
real receiver and checks that the source and healthy viewer continue to make
progress. See the [client recovery tests](../testing.md#client-recovery-acceptance).

| Case | Expected outcome |
| --- | --- |
| Subscribe while a commit races baseline capture | An earlier commit contributes to the baseline. For later commits, FIFO delivers each update in order while connected. Coalescing may skip a waiting intermediate version. |
| Subscribe after retirement advanced before the first publication, including after durable restart | The baseline preserves the positive revision, retirement floor, empty data and unobserved input status. |
| Set the message limit to one, then two | Startup rejects one. With two slots free and sufficient bytes, the viewer receives the acknowledgement followed by the baseline. |
| Set the byte limit to the pair’s exact UTF-8 size, then one byte less, using multibyte text | On an empty queue the exact fit succeeds. One byte less closes with 1009 even when each message fits individually. An individually oversized baseline also closes with 1009. |
| Leave one of two waiting slots occupied when a second subscription arrives | Close with 1013 and enqueue neither part of the new pair. |
| After both baselines drain, hold the writer and enqueue A1, A2, B1 for subscriptions A and B with two slots available | Coalescing leaves A2, B1. FIFO closes on B1. With arrivals A1, B1, A2, coalescing leaves B1, A2. |
