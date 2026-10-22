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
event names its source, type, entity, payload, and `atMs` schedule time. The
workbench prints events by `atMs`; events with the same time stay in the order
they appear in the file. Here, `atMs` only means when the workbench schedules
an event during this run. It does not define the event's domain timestamp or
ZooGlass's ordering guarantees.

The format and runner are an initial experiment and can change as the workbench
grows.
