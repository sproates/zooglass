# Fleet fixture and view contracts

This is the first executable part of the [extended vehicle demo](../../../docs/plans/extended-vehicle-demo.md).
It establishes the data contracts through the existing Workbench scenario runner.
The browser still shows the existing single-vehicle demo; fleet selection, the
geographic map and direct phone access are later increments.

## Run the contract scenario

From `incubator/workbench`, install dependencies and explicitly prepare ZooGlass
if its executable JAR has not been built from the current Java sources:

```sh
npm ci
npm run prepare:service
npm run integrate -- --fast scenarios/vehicle-fleet-contracts.json
```

The scenario also runs automatically in `npm run test:core`, in the existing
batch of fixtures sharing one service process. It opens real source and client
WebSockets, checks HTTP state and checks received client snapshots. No browser,
map provider or external feed is needed. Expected values are verification inputs;
they never populate application state.

## Entities, sources and views

The [fleet manifest](../../vehicle-tracker/fleet-manifest.json) lists three known
vehicle IDs and display names. It contains no coordinates, operational values or
history. Both sources use these same canonical IDs; this is fixture preparation,
not an entity discovery or join service. Coordinates are synthetic samples in
Gibraltar, not observations of real vehicles or verified road routes.

| View               | Field       | Source and event                                | Policy              |
| ------------------ | ----------- | ----------------------------------------------- | ------------------- |
| `fleet-state`      | `position`  | `vehicle-feed` / `vehicle.location.updated`     | `latestBySequence`  |
| `fleet-state`      | `operation` | `operations-feed` / `vehicle.operation.updated` | `latestBySequence`  |
| `received-journey` | `positions` | `vehicle-feed` / `vehicle.location.updated`     | `historyBySequence` |

Every policy reads the numeric payload field `sequence`. Location sequences
start at 40; operational sequences start at 100. They are independent domains:
a location at 42 is not older than an operation at 100. Sequence state is scoped
to the view field and entity. All three vehicles deliberately start with the same
numbers so accidental sharing between vehicles is observable.

The Node client subscribes once to each of the six view/entity pairs. Future
browser state must use both identifiers; selecting a vehicle must not replace
other vehicles' subscriptions. The manifest is not yet loaded by the browser.

## What the scenario establishes

| Phase                     | Evidence                                                                                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Initial state             | Each vehicle receives its own position, operation and one-point history.                                                                                |
| Independent contributions | Only car-17 advances to position 42; only car-28 changes operation to 102. Each retains its other field.                                                |
| Late arrivals             | Position 41 fills car-17's history without regressing its marker. Operation 101 cannot replace car-28's 102.                                            |
| Duplicates                | Identical repeats and changed payloads at an accepted sequence preserve the first accepted payload. History retains one entry per sequence.             |
| Final isolation           | Exact HTTP snapshots cover both views for all three vehicles after the barriers. Client receipts establish initial state and each changed contribution. |

An unchanged-state assertion can pass too early. After the late and duplicate
events, the scenario sends a new car-39 event on **each** source connection.
It waits for car-39's HTTP snapshot to contain both new contributions before
checking unchanged state. Each event therefore provides an observed barrier for
its own source socket. There is no assumed ordering between the two sockets.
Unchanged fields need not emit another update: receipt checks consume actual
messages and are not repeated for already-observed snapshots. This scenario does
not claim to count or reject redundant notifications.
The fixture test protects this barrier ordering and the manifest/subscription
coverage; the functional suite checks actual ZooGlass results.

These checks do not establish atomic snapshots across views, source freshness,
history completeness, correction support or durable recovery. Equal-sequence
changed payloads remain duplicates. The short fixture does not implement the
planned six-vehicle presentation or claim browser-rendering verification.
