# Scenario Simulator

The workbench can print a scenario as a deterministic timeline, or run it
against a local ZooGlass instance. The connected run uses the scenario's
simulated times as real delays while it sends events and changes client
connections.

From this directory, run the example with:

```sh
npm ci
npm run simulate -- scenarios/live-match.json
```

To start ZooGlass and play a scenario against it, run:

```sh
npm run integrate -- scenarios/live-match.json
```

This starts ZooGlass with the Maven Wrapper, waits for its health check, opens a
WebSocket connection for each event source and scenario client, and sends each
event at its scheduled simulation time. Client state changes open or close
their WebSocket connections. The scenario's view definitions are loaded by
ZooGlass at startup, and each `view-check` queries the HTTP view endpoint and
compares its data with the expected JSON. The workbench stops the local
ZooGlass process when the scenario finishes.

Pass several scenario paths to play them in order against one ZooGlass process:

```sh
npm run integrate -- scenarios/live-match.json scenarios/correction.json
```

Add `--fast` to preserve the timeline order but skip its real-time waits. The
functional test suite uses this mode; regular `integrate` runs keep the timed
playback for demonstrations.

The runner gives each scenario its own source and view IDs so its events don't
affect another scenario's views. The functional test suite uses this batch mode
to avoid starting ZooGlass separately for every scenario.

Each scenario has a name, a list of event sources, a list of clients, view
definitions, and a timeline. View definitions map event source and type pairs
to fields in a view. A field can be updated by more than one event type, and it
can also set an ordering strategy using a numeric field from each event:
`latestBySequence` keeps the event with the highest sequence, while
`historyBySequence` keeps accepted events in sequence order. These settings
work for startup views and runtime `view-definition` entries. The
`vehicle-event-ordering.json` scenario sends a newer vehicle position before
older ones, then checks both views, duplicate and invalid sequences, and a
client reconnect.

A timeline entry can be a source event, a client state change, a runtime
`view-definition`, a `client-subscription`, a `view-check`, or a
`client-view-check`. Source events have a source, type, entity, payload, and
`simulationTime`. A runtime view definition has an id and fields and is sent to
ZooGlass at that point in the timeline. A client subscription subscribes or
unsubscribes a connected client to a view and entity. A `view-check` names a view
and entity and gives the complete expected view data; use `null` to check that
no data exists for that entity. A `client-view-check` checks the view data
received by that client over WebSocket. Client state changes name a client and
its new state. The supported states are `connecting`, `connected`,
`disconnecting`, and `disconnected`.

Each client has an `initialState`. Timeline entries then record later state
changes alongside source events. `simulationTime` is the elapsed simulated time
in milliseconds when an entry is scheduled to appear. The workbench prints
entries by `simulationTime`; entries with the same time stay in the order they
appear in the file. This field does not define an event's domain timestamp or
ZooGlass's ordering guarantees.

The `simulate` command emits a combined trace without starting ZooGlass. The
`integrate` command plays the scenario over real local WebSocket connections
and checks the resulting views over HTTP and client WebSocket messages.
Client connections and subscriptions are separate timeline actions, so a
scenario can disconnect a client, keep sending source events, then reconnect,
subscribe again, and check the current snapshot it receives.

The format and runner are an initial experiment and can change as the workbench
grows.

## Scenarios

ZooGlass has unit and functional tests for its components and core running
behaviour. Most scenario testing belongs here in the Workbench: these functional
scenarios drive event and client behaviour through ZooGlass and check its view
responses. External-system tests, such as checking a Kafka adapter, are a
separate kind of integration test.

### Business examples

These scenarios show three distinct applications that could use ZooGlass:

- `sports-betting-live-market.json` combines score updates from a match feed
  with bookmaker odds and sends the changing market view to a client.
- `order-fulfilment-live-order.json` combines order, payment, and inventory
  updates for an order dashboard, including a late inventory update.
- `vehicle-tracking-live-ride.json` sends vehicle locations to a rider app,
  including disconnecting, missing updates, reconnecting, and receiving the
  latest snapshot.

They exercise live data flows and view delivery; they don't implement the
business rules of a sportsbook, order system, or ride service.

### Focused scenarios

- `live-match.json` checks a match view assembled from score and odds updates
  arriving from separate feeds.
- `late-update.json` shows an older order and inventory update arriving after
  newer order activity, then checks the view before and after the inventory
  event. The `sourceTimestamp` values are example payload data;
  `simulationTime` still says when each event appears in the replay.
- `correction.json` checks a score feed replacing an earlier result with a
  correction.
- `disconnect-catch-up.json` shows location updates arriving while a viewer is
  disconnected, then the viewer reconnecting, and checks the latest location
  view.
- `bursty-updates.json` checks the view after several odds changes arrive close
  together.
- `runtime-view-definition.json` creates two views at different points in the
  event timeline. Both match the same events, but each starts with no data and
  only reflects events received after it was created.
- `live-view-updates.json` subscribes a connected client to a view, sends events
  through ZooGlass, and checks the updates received over WebSocket.
- `client-reconnect-snapshot.json` disconnects a subscribed client while two
  updates arrive, then reconnects and checks that a new subscription receives
  the latest snapshot.
- `vehicle-event-ordering.json` sends vehicle positions out of sequence and
  checks a latest-position view and an ordered trip history view.

Run any scenario by passing its path, for example:

```sh
npm run simulate -- scenarios/late-update.json
```

## Code style

The project uses the recommended ESLint rules for JavaScript and TypeScript,
with Prettier enforcing formatting. Run the checks with:

```sh
npm run lint
npm run format:check
```

Apply formatting with `npm run format`.
