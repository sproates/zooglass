# Workbench source map

This is a reading guide to the current TypeScript modules. Start with the command
being run, then follow its dependencies to the code that does the work.

Each box is a source file. Arrows point from a module to a dependency, with labels
explaining what it uses that dependency for. Solid arrows are runtime imports;
dotted arrows are selected type dependencies. These are static relationships,
not a sequence of events or a diagram of deployed processes. Node built-ins,
external packages and most type-only imports are omitted to keep the views readable.
A file repeated in two diagrams is the same module.

Diagram paths are relative to `src/` unless shown otherwise. Modules are grouped
by responsibility, with concrete demos under `src/demos/`.

The `demos/vehicle/` folder contains its CLI (`demo.ts`), automatic playback, interactive
composition, resource ownership, asset binding and rendered-page observer.
Shared scenario execution, browser transport and playback controls have their
own folders. These modules use ordinary imports; there is no plugin loading mechanism.

## Source folders

```text
src/
├── cli/             Print-only and connected scenario commands
├── scenario/        Scenario definitions, validation and ordered traces
├── execution/       Execute actions, manage connections and check results
├── browser/         Browser lifecycle, local hosting and command execution
├── control/         Stepping, playback controls, reset and cancellation
├── service/         ZooGlass process lifecycle
└── demos/
    └── vehicle/     Compose shared components for the vehicle demo
```

`scenario/` describes and prepares the work; `execution/` performs it against
ZooGlass. `browser/` is the Node-side browser infrastructure. The sibling
`workbench/browser/` directory contains scripts served to the browser itself.
New demos can compose shared modules through ordinary imports beside `vehicle/`.
No plugin loader or registration framework is involved.

## Start with the command

| Command                           | Entry module                                                | Purpose                                                                                                  |
| --------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `npm run simulate`                | [`src/cli/simulate.ts`](../src/cli/simulate.ts)             | Load a scenario and print its ordered trace. No service is started and no results are verified.          |
| `npm run integrate`               | [`src/cli/integrate.ts`](../src/cli/integrate.ts)           | Run scenarios against a real ZooGlass process using Node clients; send events and verify expected views. |
| `npm run demo -- vehicle-tracker` | [`src/demos/vehicle/demo.ts`](../src/demos/vehicle/demo.ts) | Start the vehicle demo with browser and terminal controls, or select automatic playback with `--auto`.   |

`cli/integrate.ts` means **scenario integration with the real ZooGlass service**.
It namespaces scenario identifiers, starts one service, runs the scenarios in
order and closes the resources it owns. `--fast` skips scheduled delays, but still
executes the actions and checks. It is a CLI entry point, not a general integration
library.

```mermaid
flowchart TB
  index["cli/simulate.ts<br/>Print-only CLI"]
  integration["cli/integrate.ts<br/>Connected scenario CLI"]
  demo["demos/vehicle/demo.ts<br/>Vehicle demo CLI"]
  scenario["scenario/scenario.ts<br/>Load and validate fixtures"]
  playback["scenario/playback.ts<br/>Build and format ordered traces"]
  vehicle["demos/vehicle/vehicle-demo.ts<br/>Interactive demo composition"]
  automatic["demos/vehicle/automatic-demo.ts<br/>Automatic demo playback"]
  index -->|loads fixture| scenario
  index -->|prints ordered entries| playback
  integration -->|loads fixtures| scenario
  integration -->|schedules and prints entries| playback
  demo -->|loads interactive fixture| scenario
  demo -->|creates interactive controls| vehicle
  demo -->|runs with --auto| automatic
  automatic -->|loads automatic fixture| scenario
  automatic -->|plays ordered entries| playback
```

## Turn a fixture into an executable trace

[`scenario/scenario.ts`](../src/scenario/scenario.ts) is the public loader/parser and re-exports the
scenario types. The smaller parser modules validate their own portions of the
JSON. [`scenario/playback.ts`](../src/scenario/playback.ts) turns a validated scenario into ordered
trace entries; callers decide when and where those entries execute.

```mermaid
flowchart TB
  scenario["scenario/scenario.ts<br/>Load and parse the whole fixture"]
  timeline["scenario/scenario-timeline.ts<br/>Parse actions and check references"]
  view["scenario/scenario-view.ts<br/>Parse view definitions"]
  validation["scenario/scenario-validation.ts<br/>Shared field checks"]
  model["scenario/scenario-model.ts<br/>Scenario data types"]
  playback["scenario/playback.ts<br/>Produce trace entries"]
  scenario -->|parses timeline| timeline
  scenario -->|parses initial views| view
  scenario -->|checks fields and client states| validation
  timeline -->|parses runtime view definitions| view
  timeline -->|checks fields and client states| validation
  view -->|checks definition fields| validation
  scenario -.->|uses and re-exports types| model
  timeline -.->|uses timeline types| model
  view -.->|uses view types| model
  validation -.->|uses client-state type| model
  playback -.->|accepts Scenario| scenario
```

## Execute against ZooGlass

[`service/zooglass-session.ts`](../src/service/zooglass-session.ts) owns the Java process, temporary
configuration, readiness checks and shutdown. [`execution/scenario-session.ts`](../src/execution/scenario-session.ts)
owns one scenario's connections and dispatches its trace entries. It does not
schedule delays or start a browser.

```mermaid
flowchart TB
  integration["cli/integrate.ts<br/>Connected scenario CLI"]
  namespace["scenario/namespace-scenario.ts<br/>Isolate scenario identifiers"]
  service["service/zooglass-session.ts<br/>Own the service process"]
  session["execution/scenario-session.ts<br/>Dispatch actions and own connections"]
  http["execution/view-http.ts<br/>Define and check server views"]
  client["execution/node-client-executor.ts<br/>Execute client actions and check receipts"]
  sockets["execution/sockets.ts<br/>Connect, buffer and close WebSockets"]
  integration -->|avoids clashes between fixtures| namespace
  integration -->|starts and closes ZooGlass| service
  integration -->|opens and executes each scenario| session
  session -->|defines and checks HTTP views| http
  session -->|creates the default client executor| client
  session -->|opens and closes source connections| sockets
  client -->|manages client connections and messages| sockets
```

The session accepts a `ClientExecutor` factory. Normal connected runs use the
Node executor. Browser demo composition supplies an executor from the browser
host instead. This is the existing seam that keeps browser and vehicle details
out of scenario execution.

## Assemble the vehicle demo

[`control/demo-controller.ts`](../src/control/demo-controller.ts) controls stepping, playback,
reset and cancellation through the `DemoRun` contract. It does not import the
vehicle app or browser host. [`vehicle-demo.ts`](../src/demos/vehicle/vehicle-demo.ts) supplies
the concrete run and the vehicle-specific disconnect/reconnect actions.

```mermaid
flowchart TB
  vehicle["demos/vehicle/vehicle-demo.ts<br/>Interactive vehicle composition"]
  automatic["demos/vehicle/automatic-demo.ts<br/>Automatic playback and failure inspection"]
  controller["control/demo-controller.ts<br/>Step, play, pause and reset"]
  steps["control/demo-steps.ts<br/>Group entries into checkpoints"]
  playback["scenario/playback.ts<br/>Produce ordered trace entries"]
  run["demos/vehicle/vehicle-run.ts<br/>Acquire and release demo resources"]
  service["service/zooglass-session.ts<br/>Own ZooGlass process"]
  browser["demos/vehicle/vehicle-browser.ts<br/>Supply vehicle assets and identity"]
  session["execution/scenario-session.ts<br/>Execute scenario actions"]
  observer["demos/vehicle/vehicle-observer.ts<br/>Check the rendered vehicle page"]
  descriptions["demos/vehicle/vehicle-step-description.ts<br/>Explain planned actions and progress"]
  vehicle -->|describes the current or next step| descriptions
  descriptions -->|reads ordered actions| playback
  descriptions -->|uses checkpoint boundaries| steps
  vehicle -->|creates interactive controller| controller
  vehicle -->|opens replacement runs| run
  automatic -->|opens an automatic run| run
  controller -->|builds trace| playback
  controller -->|groups trace into steps| steps
  run -->|uses cleanup error class| controller
  run -->|starts and closes service| service
  run -->|starts and closes vehicle browser| browser
  run -->|injects browser executor into session| session
  run -->|wraps execution with page checks| observer
  observer -.->|wraps ScenarioSession contract| session
```

The arrow back to `control/demo-controller.ts` is a real import of `DemoCleanupError`.
The map shows the code as it exists, including small dependencies that are easy
to miss when reading a directory listing.

`vehicle-step-description.ts` describes planned actions without inferring results.
`vehicle-run.ts` publishes a demo activity notification only after a source-send
action succeeds. Neither changes the shared execution or control contracts.

The observer is optional demo verification assembled by `vehicle-run.ts`.
It reads the rendered page independently of the vehicle app's rendering code.
The shared scenario session and client executors do not depend on it.

## Host the browser and bind the app

[`browser/browser-session.ts`](../src/browser/browser-session.ts) owns Chromium, its context/page
and the local host. [`browser/browser-host.ts`](../src/browser/browser-host.ts) serves supplied
assets, accepts the browser control connection and proxies its data connection
to ZooGlass. It has no dependency on the vehicle app's implementation.

```mermaid
flowchart TB
  vehicle["src/demos/vehicle/vehicle-browser.ts<br/>Vehicle asset and identity binding"]
  session["src/browser/browser-session.ts<br/>Own Chromium and local host"]
  host["src/browser/browser-host.ts<br/>Assets, control channel and data proxy"]
  executor["src/browser/browser-client-executor.ts<br/>Send commands and check observations"]
  contract["src/execution/node-client-executor.ts<br/>ClientExecutor and ClientEntry types"]
  vehicle -->|starts owned browser session| session
  vehicle -->|can start host alone| host
  session -->|starts and closes host| host
  host -->|creates browser command executor| executor
  executor -.->|implements shared executor contract| contract
```

The host serves browser modules as assets; it does not import them into Node.
The next diagram crosses into the browser source, where the two `.js` modules
are authored JavaScript and the three `.ts` modules compile to served JavaScript.

```mermaid
flowchart TB
  bootstrap["workbench/browser/vehicle-bootstrap.js<br/>Wire page controls and app to bridge"]
  bridge["workbench/browser/bridge.js<br/>Control protocol and command dispatch"]
  client["vehicle-tracker/src/vehicle-client.ts<br/>Bind vehicle policy and presentation"]
  subscription["vehicle-tracker/src/subscription-client.ts<br/>Socket, subscriptions and acknowledgements"]
  view["vehicle-tracker/src/view.ts<br/>Render vehicle data and status"]
  activity["vehicle-tracker/src/activity.ts<br/>Render bounded run diagnostics"]
  bootstrap -->|forwards actual observations and source-send notices| activity
  bootstrap -->|starts control bridge with client factory| bridge
  bootstrap -->|creates vehicle client| client
  client -->|creates subscription client with callbacks| subscription
  client -->|supplies rendering callbacks| view
```

The browser bridge knows the supplied client interface. It does not import the
vehicle client. Likewise, the subscription client receives callbacks rather
than importing the vehicle renderer. These boundaries let the shared machinery
be read independently of the demo's presentation.

## Use the map while reading

For a first connected run, read `cli/integrate.ts`, then `execution/scenario-session.ts`,
then the executor or HTTP helper for the action you are interested in. For a
browser demo, start with `demo.ts`, then `vehicle-demo.ts` and `vehicle-run.ts`.
The controller explains interaction; the browser host explains transport; the
vehicle app explains presentation.

These diagrams cover the production TypeScript modules and the JavaScript
bootstrap needed to understand their browser boundary. Tests, fixtures, Java
implementation and external libraries are outside this map. See the
[verification map](../../../docs/testing.md) for the test structure and
[Workbench README](../README.md) for commands and scenarios.

When a module is added or its responsibility or dependencies change, update the
relevant view here alongside the code. Keep labels about the purpose of each
relationship, rather than reducing them to “imports”.

For the adjacent components, see the [ZooGlass source map](../../zooglass/docs/source-map.md)
and [vehicle-tracker source map](../../vehicle-tracker/docs/source-map.md).
