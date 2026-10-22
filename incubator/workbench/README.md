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

To start ZooGlass and send a scenario to it over WebSockets, run:

```sh
npm run integrate -- scenarios/live-match.json
```

This starts ZooGlass with the Maven Wrapper, waits for its health check, opens a
WebSocket connection for each event source and scenario client, and sends each
event at its scheduled simulation time. Source connections send JSON messages
to ZooGlass; client state changes open or close their WebSocket connections.
ZooGlass currently logs received messages and does not process or deliver them
to connected clients. The workbench stops the local ZooGlass process when the
scenario finishes.

Each scenario has a name, a list of event sources, a list of clients, and a
timeline. A timeline entry is either a source event or a client state change.
Source events have a source, type, entity, payload, and `simulationTime`. Client
state changes name a client and its new state. The supported states are
`connecting`, `connected`, `disconnecting`, and `disconnected`.

Each client has an `initialState`. Timeline entries then record later state
changes alongside source events. `simulationTime` is the elapsed simulated time
in milliseconds when an entry is scheduled to appear. The workbench prints
entries by `simulationTime`; entries with the same time stay in the order they
appear in the file. This field does not define an event's domain timestamp or
ZooGlass's ordering guarantees.

The `simulate` command emits a combined trace without starting ZooGlass. The
`integrate` command drives ZooGlass over real local WebSocket connections, but
does not check what a client would receive.

The format and runner are an initial experiment and can change as the workbench
grows.

## Scenarios

There are a few small examples now. Each one is a timeline to discuss and
exercise as the workbench grows. The print-only simulator does not apply
business rules or check what ZooGlass would do with the events. The connected
runner sends the events to ZooGlass, which currently logs them without applying
business rules.

- `live-match.json` shows score and odds updates arriving from separate feeds.
- `late-update.json` shows an older order and inventory update arriving after
  newer order activity. The `sourceTimestamp` values are example payload data;
  `simulationTime` still says when each event appears in the replay.
- `correction.json` shows a score feed correcting a result it reported earlier.
- `disconnect-catch-up.json` shows location updates arriving while a viewer is
  disconnected, then the viewer reconnecting. The connected runner applies
  those connection changes, but ZooGlass does not yet deliver updates to the
  viewer.
- `bursty-updates.json` shows several odds changes arriving close together.

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
