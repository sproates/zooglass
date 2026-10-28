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
  demo["demos/vehicle/demo.ts<br/>Interactive CLI"]
  fleetAssets["demos/vehicle/fleet-assets.ts<br/>Map configuration and fleet assets"]
  demo -->|chooses interactive tile configuration| fleetAssets
  browser -->|loads fleet modules and Leaflet assets| fleetAssets
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
configuration, readiness checks and shutdown. It launches the already-built
`zooglass/target/zooglass.jar` directly with Java, without a shell or Maven.
[`scripts/prepare-service.js`](../scripts/prepare-service.js), outside `src/`, is
an explicit developer/CI preparation command. Session modules do not import or
call it; there is no runtime dependency from session startup to the build step.
[`execution/scenario-session.ts`](../src/execution/scenario-session.ts)
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
  faults["demos/vehicle/vehicle-faults.ts<br/>Coordinate gate, recovery observations and first snapshots"]
  host["browser/browser-host.ts<br/>Expose data gate and browser observations"]
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
  run -->|creates fault handler and checks first snapshots| faults
  faults -.->|uses BrowserHost type for gate and observation API| host
  run -->|injects fault callback| session
  run -->|wraps execution with page checks| observer
  observer -.->|wraps ScenarioSession contract| session
  fleetObserver["demos/vehicle/fleet-observer.ts<br/>Check fleet rows and selected history"]
  run -->|chooses fleet page checks in fleet mode| fleetObserver
  fleetObserver -.->|wraps ScenarioSession contract| session
```

The arrow back to `control/demo-controller.ts` is a real import of `DemoCleanupError`.
The map shows the code as it exists, including small dependencies that are easy
to miss when reading a directory listing.

`vehicle-step-description.ts` describes planned actions without inferring results.
`vehicle-run.ts` publishes a demo activity notification only after a source-send
action succeeds. Neither changes the shared execution or control contracts.

`vehicle-faults.ts` arms recovery, controls the gate and waits for current-run
observations. After restoration it compares each view's first snapshot with the
scenario expectation. The shared session dispatches fault entries through an
injected callback and rejects unsupported scenarios before allocating resources;
it does not import the vehicle adapter.

The observers are optional demo verification assembled by `vehicle-run.ts`.
Fleet mode checks list rows and selected history without changing selection;
unselected histories are receipt-checked. The fleet browser test separately
selects each vehicle to check its detail.
It reads the rendered page independently of the vehicle app's rendering code.
The shared scenario session and client executors do not depend on it.

## Serve independent external viewers

The `--bind=<IPv4>` path selects external mode explicitly. The terminal owns the
demo lifetime; the demo composes shared playback with a source/HTTP-only scenario.
Viewer setup and targeted actions stay in the vehicle adapter. The external host
knows leases, roles, control connections and per-viewer run bindings, not vehicles.

```mermaid
flowchart TB
  cli["src/demos/vehicle/demo.ts<br/>Choose owned or external mode"]
  terminal["src/demos/vehicle/external-vehicle-terminal.ts<br/>Pairing links, handover and shutdown"]
  demo["src/demos/vehicle/external-vehicle-demo.ts<br/>Compose external fleet demonstration"]
  controls["src/demos/vehicle/external-vehicle-controls.ts<br/>Subscribe each viewer and target data faults"]
  host["src/browser/external-browser-host.ts<br/>Viewer connections, admission and shared run replacement"]
  leases["src/browser/viewer-leases.ts<br/>Pairing, refresh capabilities and controller authority"]
  http["src/browser/browser-http-server.ts<br/>Asset allowlist and network boundary"]
  run["src/browser/browser-run.ts<br/>Per-viewer commands, observations and data route"]
  controller["src/control/demo-controller.ts<br/>Shared playback and Reset"]
  session["src/execution/scenario-session.ts<br/>Dispatch sources and check HTTP views"]
  service["src/service/zooglass-session.ts<br/>Own loopback service"]
  assets["src/demos/vehicle/vehicle-browser.ts<br/>Supply fleet application assets"]
  cli -->|selects explicit external mode| terminal
  terminal -->|creates demo and invokes commands| demo
  demo -->|supplies application and callbacks| host
  demo -->|binds viewer subscriptions and faults| controls
  demo -->|uses source playback lifecycle| controller
  demo -->|opens source and HTTP checks| session
  demo -->|starts and closes service per run| service
  demo -->|loads fleet assets| assets
  host -->|claims leases and checks controller revisions| leases
  host -->|serves exact assets and validates upgrades| http
  host -->|creates one binding per connected viewer| run
  controls -.->|uses executor and fault API| run
```

Browser `bridge.js` consumes pairing or session-storage credentials, then keeps
run-change handling independent of the demo. `vehicle-bootstrap.js` presents the
controller role and target-viewer selector. External observers remain optional;
owned-browser mode retains its required scripted client. See the
[external-viewer guide](external-viewers.md) for the runtime contract and limits.

## Host the browser and bind the app

[`browser/browser-session.ts`](../src/browser/browser-session.ts) composes an owned
browser and local host for existing verification. The independent lifetimes and
replacement handshake are described in [Browser host and run lifetimes](browser-lifetime.md).
The host owns assets and the control connection; each run owns its executor,
receipts and data fault gate. The launcher owns only Chromium.

```mermaid
flowchart TB
  vehicle["src/demos/vehicle/vehicle-browser.ts<br/>Vehicle asset and identity binding"]
  session["src/browser/browser-session.ts<br/>Compose owned verification session"]
  launcher["src/browser/owned-browser.ts<br/>Own Chromium and page"]
  host["src/browser/browser-host.ts<br/>Stable assets and control connection"]
  run["src/browser/browser-run.ts<br/>Run identity, readiness and observations"]
  route["src/browser/browser-data-route.ts<br/>Proxy connections and fault gate"]
  executor["src/browser/browser-client-executor.ts<br/>Send commands and check observations"]
  contract["src/execution/node-client-executor.ts<br/>ClientExecutor and ClientEntry types"]
  fleetAssets["src/demos/vehicle/fleet-assets.ts<br/>Fleet modules, Leaflet assets and tile configuration"]
  vehicle -->|loads fleet assets and declares image origin| fleetAssets
  vehicle -->|starts owned browser session| session
  vehicle -->|can start host alone| host
  session -->|starts and closes host| host
  session -->|launches and closes Chromium| launcher
  http["src/browser/browser-http-server.ts<br/>Exact assets and Host/Origin boundary"]
  host -->|serves assets and checks network boundary| http
  host -->|creates and retires run binding| run
  run -->|owns data proxy and fault gate| route
  run -->|binds commands and receipts to run identity| executor
  executor -.->|implements shared executor contract| contract
```

The host serves browser modules as assets; it does not import them into Node.
Applications may declare exact HTTPS image origins; scripts and data connections
remain local. Fleet composition supplies that declaration for the tile provider.
The demo CLI chooses interactive tile configuration; programmatic sessions default
to local synthetic tiles.
The next diagram crosses into the browser source, where the two `.js` modules
are authored JavaScript and the `.ts` modules compile to served JavaScript.

```mermaid
flowchart TB
  bootstrap["workbench/browser/vehicle-bootstrap.js<br/>Wire page controls and app to bridge"]
  bridge["workbench/browser/bridge.js<br/>Control protocol and run replacement"]
  client["vehicle-tracker/src/vehicle-client.ts<br/>Bind vehicle policy and presentation"]
  subscription["vehicle-tracker/src/subscription-client.ts<br/>Socket, subscriptions and acknowledgements"]
  view["vehicle-tracker/src/view.ts<br/>Render vehicle data and status"]
  activity["vehicle-tracker/src/activity.ts<br/>Render bounded run diagnostics"]
  bootstrap -->|forwards actual observations and source-send notices| activity
  bootstrap -->|starts control bridge with client factory| bridge
  bootstrap -->|creates vehicle client| client
  recovery["vehicle-tracker/src/recovering-client.ts<br/>Bounded retry and snapshot recovery policy"]
  client -->|creates recovery client with callbacks| recovery
  recovery -->|creates protocol client for each attempt| subscription
  client -->|supplies rendering callbacks| view
  fleet["vehicle-tracker/src/fleet/client.ts<br/>Bind fleet model and renderer"]
  model["vehicle-tracker/src/fleet/model.ts<br/>Received view/entity state and local selection"]
  fleetView["vehicle-tracker/src/fleet/view.ts<br/>Fleet list and selected details"]
  manifest["vehicle-tracker/fleet-manifest.json<br/>Descriptive vehicle identities"]
  bootstrap -->|loads fleet factory in fleet mode| fleet
  bootstrap -.->|fetches manifest for fleet factory| manifest
  fleet -->|creates model and validates subscriptions| model
  fleet -->|creates renderer and refreshes on receipts| fleetView
  fleetMap["vehicle-tracker/src/fleet/map.ts<br/>Received markers and selected geographic route"]
  leaflet["Leaflet distribution<br/>Locally served map library"]
  fleet -->|creates map and refreshes on receipts| fleetMap
  mapControls["vehicle-tracker/src/fleet/map-controls.ts<br/>Fit and follow navigation"]
  mapTiles["vehicle-tracker/src/fleet/map-tiles.ts<br/>Background status, attribution and retry"]
  fleetMap -->|creates local camera controls| mapControls
  mapControls -->|pans and fits| leaflet
  mapControls -.->|reads received positions and selection| model
  fleetMap -->|adds background independently of data| mapTiles
  mapTiles -->|loads tiles and observes availability| leaflet
  fleetMap -->|draws geographic layers| leaflet
  fleetMap -.->|reads received coordinates| model
  fleetMap -.->|selection callback| fleet
  fleetView -.->|reads model| model
  fleetView -.->|selection callback| fleet
  fleet -->|reuses transport recovery| recovery
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

## Continuous Gibraltar demonstration

`npm run demo:drive` uses this small demo-specific composition. There is no
controller, pairing lease, browser command channel or dependence on a viewer's
presence. The static host exposes assets and the live subscription proxy only.

```mermaid
flowchart TD
  main["continuous/main.ts"] -->|starts and shuts down| sim["continuous/simulation.ts"]
  sim -->|owns prebuilt service| service["service/zooglass-session.ts"]
  sim -->|serves read-only viewer| http["browser/browser-http-server.ts"]
  sim -->|forwards live subscriptions| proxy["browser/browser-data-route.ts"]
  sim -->|loads assets| assets["continuous/application.ts"]
  assets -->|reuses Leaflet and tile assets| fleet["demos/vehicle/fleet-assets.ts"]
  sim -->|runs six independent sources| producer["continuous/producer.ts"]
  sim -->|loads cars| journeys["continuous/journeys.ts"]
  producer -->|samples distance along roads| journeys
  journeys -->|reads attributed road geometry| routes["continuous/routes.json"]
  producer -->|chooses automatic faults| delivery["continuous/delivery.ts"]
  producer -->|opens and closes real sockets| sockets["execution/sockets.ts"]
```

[Behaviour and limits](continuous-driving.md). The browser source map describes
its passive subscriber and map, separately from the scripted bridge.
