# Scenario Simulator

The workbench currently reads a small JSON scenario and prints its events as a
deterministic timeline. It uses simulated time only; it does not wait in real
time or connect to a broker or other service.

From this directory, run the example with:

```sh
npm ci
npm run simulate -- scenarios/live-match.json
```

Each scenario has a name, a list of event sources, and a list of events. An
event names its source, type, entity, payload, and `simulationTime`. This is the
elapsed simulated time in milliseconds when the event is scheduled to appear.
The workbench prints events by `simulationTime`; events with the same time stay
in the order they appear in the file. This field does not define the event's
domain timestamp or ZooGlass's ordering guarantees.

The format and runner are an initial experiment and can change as the workbench
grows.

## Scenarios

There are a few small examples now. Each one is a timeline to discuss and
exercise as the workbench grows. At the moment, the simulator only prints the
events. It doesn't model a client, apply business rules, or check what ZooGlass
would do with them.

- `live-match.json` shows score and odds updates arriving from separate feeds.
- `late-update.json` shows an older order and inventory update arriving after
  newer order activity. The `sourceTimestamp` values are example payload data;
  `simulationTime` still says when each event appears in the replay.
- `correction.json` shows a score feed correcting a result it reported earlier.
- `disconnect-catch-up.json` shows location updates while a viewer is away,
  followed by updates sent after it reconnects. The connection and replay events
  are part of the example timeline, not behaviour the simulator implements.
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
