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
