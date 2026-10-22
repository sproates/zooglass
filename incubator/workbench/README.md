# Scenario Simulator

The workbench currently reads a small JSON scenario and prints its source events
and client state changes as a deterministic timeline. It uses simulated time
only; it does not wait in real time or connect to a broker or other service.

From this directory, run the example with:

```sh
npm ci
npm run simulate -- scenarios/live-match.json
```

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

The runner emits a combined trace of source events and client state changes. It
doesn't connect to ZooGlass, deliver events to clients, or check what a client
would receive. It's a way to describe and inspect scenario timing for now.

The format and runner are an initial experiment and can change as the workbench
grows.

## Scenarios

There are a few small examples now. Each one is a timeline to discuss and
exercise as the workbench grows. At the moment, the simulator only prints the
timeline. It doesn't apply business rules or check what ZooGlass would do with
the events.

- `live-match.json` shows score and odds updates arriving from separate feeds.
- `late-update.json` shows an older order and inventory update arriving after
  newer order activity. The `sourceTimestamp` values are example payload data;
  `simulationTime` still says when each event appears in the replay.
- `correction.json` shows a score feed correcting a result it reported earlier.
- `disconnect-catch-up.json` shows location updates arriving while a viewer is
  disconnected, then the viewer reconnecting. It doesn't simulate what the
  viewer receives after reconnecting.
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
