# Vehicle fleet demo

Status: proposed design for review. The existing single-vehicle demo is delivered;
this document describes the next experience, not capabilities already implemented.

## What someone should be able to do

Open the demo on a laptop or directly on a phone on the same network. See a small
fleet on a geographic map, select a vehicle, inspect its received journey and
operational status, and understand what changes when an update is late or the
viewer loses its connection. Workbench supplies repeatable scenarios and controls;
ZooGlass supplies the application state. This should feel like a usable fleet
viewer with an inspectable demonstration mode, not a test log with a map attached.

The proposed finished scope is six synthetic vehicles, each with a finite route
of about sixty positions over roughly five minutes of scenario time, plus a
separate operational-status feed. Start delivery with three vehicles, but retain
the complete experience as the target. This is not a scale benchmark.

![Proposed desktop and phone experience, with fleet selection, map and vehicle detail.](../diagrams/vehicle-fleet-experience.svg)

### The experience

- A fleet list shows each vehicle's name, latest received position and operational
  status. Selecting a row or marker selects the same vehicle in every panel.
- The map shows all received latest positions and the selected vehicle's received
  route. Fit fleet and Follow selected are explicit controls. User panning turns
  off follow mode; updates must not repeatedly drag the map away from the user.
- Detail shows coordinates, source sequence, received history and status such as
  available, on a job or returning. These labels are simulated operational facts,
  not inferred from motion or implemented dispatch/payment workflows.
- Step, Play, Pause and Reset remain accessible. Scenario selection explains the
  behaviour about to be demonstrated. Changing scenario creates a fresh run;
  it never mixes one fixture's state with another's.
- An expandable “What happened?” panel separates source sends, actual receipts
  and checks. The main screen gives a concise explanation; technical detail is
  available without dominating ordinary exploration.
- On a phone, controls and selection stay usable above a map and stacked detail.
  Touch, keyboard, visible focus, text alternatives and 200% text enlargement
  are acceptance requirements. No hover-only interaction or colour-only status.

Use received coordinates only. Do not invent movement through interpolation,
map matching or directions services. A line between positions illustrates the
received history, not a verified road journey. Use deliberately authored synthetic
coordinates in one compact real geographic area; explain their synthetic origin.

## What this should establish

The demo should make three kinds of reuse visible: different views of one feed,
independent fields contributed by different feeds, and the same rules applied to
several entities. Adding a new vehicle or supported source contribution should
not require a vehicle-specific change to ZooGlass's core.

| Demonstration | Expected observation |
| --- | --- |
| Ordinary fleet movement | Vehicles advance independently. Selecting one does not stop the rest or change their server state. |
| Late position and duplicate | One vehicle's history acquires a delayed position while its latest marker stays ahead. An identical duplicate adds no history entry after a processing barrier. Other vehicles retain their own state. |
| Independent status feed | Status changes while location does not, and location changes without overwriting status. Both arrive through the real service. |
| Deliberate viewer disconnect | All retained values are labelled accordingly. Sources continue; reconnect receives the first current snapshot for every desired view/entity pair before later events can conceal stale recovery. |
| Unexpected data interruption | The proxy breaks the actual route, rejects at least one retry, and lets sources advance. Restoring only the route permits bounded client recovery. Control remains available. |
| Quiet location source | A selected location stops changing while status continues. The UI reports receipt age and observed values, without claiming the source is healthy, stale or complete. This makes the missing freshness contract visible. |
| Reset or scenario change | Old data, receipts and commands cannot affect the replacement run. A fresh viewer starts waiting for real snapshots. |

Recovery fixtures first establish a snapshot for each required view/entity pair
and wait for those receipts before the fault. After restoration, recovery waits
for every desired pair, not merely the selected vehicle. An intentionally
unpopulated pair stays waiting and must be declared as such in its fixture,
rather than being silently counted as recovered.

Keep journey, ordering, deliberate recovery and unexpected loss as named finite
scenarios. Use a dedicated short fault sequence so a five-minute presentation
does not depend on leaving a thirty-second recovery window open. Manual source
or connection interventions mark exploration and invalidate affected scripted
checks explicitly; they never turn an unverified result into a passing scenario.

## Views and application responsibilities

Use an explicit demo manifest for known vehicle IDs, display names and scenario
choices. It may contain descriptive metadata, but not current coordinates,
status or history used to populate the screen. No wildcard subscription or fleet
discovery API is implied.

For each vehicle, propose two views:

| View | Fields and policy |
| --- | --- |
| Fleet state | `position` from the location feed, using `latestBySequence`; `operation` from a separate status feed, using its own `latestBySequence` field policy and sequence domain. |
| Received journey | Location payloads using `historyBySequence`. |

Both sources use the same canonical vehicle ID in this fixture. This is explicit
source preparation, not a relationship/join capability. Equal-sequence changed
payloads remain first-accepted duplicates, not corrections. Status gets its own
numeric ordering domain so a late status cannot regress it, without sharing the
location sequence counter.

Initially subscribe to both views for every manifest vehicle: twelve subscriptions
for six vehicles on one viewer connection. Selection changes presentation only.
Keep state keyed by `(viewId, entityId)` and reject unknown pairs. No duplicate
subscription on selection, reset or reconnect. Missing data stays visibly waiting;
an empty history snapshot is distinct from no snapshot. Fleet-state fields can
reflect different source times, and the two views are not an atomic pair.

This bounded subscription set avoids introducing entity discovery or dynamic
subscription churn merely to draw a small fleet. Revisit selective subscriptions
before increasing fleet size materially. Histories remain finite because the
service's history retention is unbounded and updates send full snapshots.

Move the existing hard-coded vehicle binding and renderer towards small modules
for fleet state, selection, map presentation and detail. Keep transport/recovery
independent of Leaflet and vehicle IDs. Do not introduce a plugin framework or a
new frontend framework as part of this design. Update source maps as those
responsibilities actually change; the current maps describe current code.

## Map choice and failure behaviour

Propose Leaflet, bundled locally with the demo, and a configurable raster tile
source. It supports markers, polylines and touch maps without requiring a provider
account. The first human-facing local demo can use the standard OpenStreetMap
raster endpoint; a publicly hosted or heavily used demo needs a separate provider
decision. See the [Leaflet guide](https://leafletjs.com/examples/quick-start/).

The tile source supplies the background only. Coordinates, status and paths still
come from ZooGlass. Show attribution persistently. Honour normal browser caching,
use HTTPS tiles and an origin-only cross-origin referrer, and do not prefetch or
bulk-download areas. Provider availability is best-effort; the service can change
or restrict access. Keep the URL and attribution configurable. These choices
follow the [OSMF tile policy](https://operations.osmfoundation.org/policies/tiles/),
reviewed 27 October 2026; recheck it at implementation.

Tests must use local synthetic tiles or intercept requests; automated browsers
must never sweep the public tile service. No offline map download feature is
planned. If tiles fail, preserve coordinates, list, history, selection and controls,
and show “Map background unavailable”. Loss of tiles must not be reported as a
ZooGlass disconnection. Automated correctness does not depend on map availability.

## Direct phone access and browser ownership

![Proposed shared scenario with owned or directly attached browser, separate data and control paths, and external map tiles.](../diagrams/vehicle-fleet-architecture.svg)

Retain local owned-browser mode for scripted verification. Add an explicit
external-browser mode that binds the demo host to a selected local network
interface and prints a pairing link. Default remains loopback. The phone loads
and runs the actual app and opens its own data and control WebSockets; no remote
screenshots or browser-control port are exposed.

The application host and the owned-browser launcher need separate lifetimes.
An external page must keep its URL and control connection across Reset, while
Workbench replaces the ZooGlass session, data route and run identity. The app
clears old state on a run-change handshake and acknowledges readiness before
scenario actions resume. The old data socket is closed; stale run messages and
queued commands are rejected. Owned-browser mode can retain its current fresh
page behaviour. Keep this as ordinary session composition, not a generic host
plugin system.

Proposed external-session rules:

- One paired active browser per run initially. A second browser cannot silently
  take ownership. The terminal can explicitly revoke pairing and issue a new
  link. Multiple independent viewers remain a possible later increment, not an
  unimplemented promise hidden in this design.
- Put a high-entropy pairing secret in the URL fragment, consume it for registration
  and remove it from browser history after pairing. Use a session capability for
  subsequent control and data access; invalidate it on unpair/exit. Reset rotates
  run/data-route identities without requiring the human to pair again.
- Admit only the configured Host and exact allowed Origin; check both on socket
  upgrades and control requests. Serve an exact asset allowlist, with bounded
  messages and no filesystem or arbitrary URL proxy. Keep ZooGlass on loopback.
- Make pairing expire if unused, propose five minutes. A page refresh can resume
  the same browser lease using session-scoped credentials; a second active socket
  cannot claim it. Control loss pauses dispatch and marks the run interrupted.
  Reattachment requires a fresh run before scripted verification can resume.
- Phone backgrounding or Wi-Fi loss can drop control as well as data. Do not call
  that a successful controlled data-fault test. Show a reconnect/reset action on
  return, with terminal reset/re-pair available when the page cannot recover.
- Limit this mode to synthetic data on a trusted local network. Plain local HTTP
  is not confidential transport. This pairing mechanism is demo-host access,
  not the required ZooGlass application authorisation model or internet hosting.

The host's current `no-referrer` policy and restrictive image/style CSP need a
narrow app-specific change for map tiles and Leaflet styling. Pairing secrets
must never be in tile URLs, referrers or logs. Use fragment/session credentials,
`strict-origin-when-cross-origin`, and an explicit configured tile-origin policy;
do not weaken host checks or enable arbitrary scripts. Test these headers and
cross-origin rejection. No paid service or public tunnel is selected.

## Verification remains separate from presentation

Workbench continues to own scenario time, source actions, connections, fault
control, reset and one overall outcome. Service and client-receipt assertions
establish view semantics; a browser model is useful for inspection but is not
independent proof of received values. Expected fixture values never populate app
state. Optional demo observers check rendering without moving UI testing into
Workbench's core.

Owned-browser runs must independently check marker identity/location, selected
history, status fields, retained-state labels and mobile layout. Use local tiles.
External-phone runs can execute HTTP and receipt checks, but cannot claim a
Playwright rendering pass. Their outcome must name the checks actually run and
mark visual inspection manual/unverified. Follow with a real iPhone/Safari
walkthrough; a desktop WebKit run is complementary evidence, not an iPhone test.

Test multiple entities, source isolation, late status and location, duplicates,
first snapshots on reconnect, per-view waiting states and old-run rejection.
For the host, test wrong/absent tokens, wrong Origin/Host, second registrations,
expired pairing, page refresh, control loss, re-pair and reset on the same page.
Retain existing core, lifecycle and three-engine checks. Do not put map-provider
availability or every visual variation on the critical path of every small PR.

## Incremental delivery

Each increment leaves a usable result and includes relevant tests, docs and source
map updates. These are delivery boundaries, not a promise of one PR per row.

| Increment | Usable result | Acceptance boundary |
| --- | --- | --- |
| Fleet state and selection | Three vehicles, shared field policies, selected detail and text/schematic display; preserve the existing short fixtures. | Real entity isolation and independent status/location updates; state keyed by view/entity; selection cannot mix vehicles. |
| Geographic map | Bundled Leaflet, real background, all markers, selected history, fit/follow controls and responsive text alternative. | Actual received coordinates; keyboard/touch/reflow; tile failures leave the demo useful; CI uses local tiles. |
| Direct network browser | Explicit bind/pair command, real phone app, stable host across Reset and clear outcome labels. | Registration/Origin boundaries, run handover, refresh/background loss and a manual iPhone walkthrough. |
| Scenario experience | Six vehicles and fuller finite routes, named demonstrations, concise explanations and expandable evidence. | Late/duplicate/source-quiet/recovery cases independently checked; short fault run respects its deadline. |
| Acceptance and value review | Documented desktop/phone walkthrough, screenshots/recording and an application-work comparison. | Reproducible setup/cleanup, claims reconciled, evidence linked and remaining gaps visible. |

The network host lifecycle is the largest change and may need two focused PRs:
separate host/browser ownership first, then pairing and external-page reset.
Do not make the map or the richer presentation wait for a broad client framework.

## Demonstrating value and deciding what follows

Record what was needed to add the status feed, a vehicle and another supported
view: definitions, source translation, app binding, server changes and checks.
Compare those responsibilities with a minimal custom-service design offering the
same in-memory semantics. Do not inflate the alternative with durable storage or
permissions ZooGlass does not yet supply, or turn line counts into hours saved.
Core edits required merely to add a domain example count as an adoption gap.

The first version does not add source freshness guarantees, revision corrections,
durable replay, production retention, external fleet adapters, dispatch optimisation
or application authorisation. Keep the [authorisation requirement](../requirements/authorisation.md)
visible. If real protected data or external users enter scope, revisit that
boundary before deployment. Design freshness next around an explicit source-quiet
case; receipt age alone does not establish source progress or completeness.

Review should confirm the proposed six-vehicle target and map choice, the
single-active-browser boundary and the network lifecycle before implementation.
Direct phone access is a requirement; the mechanisms above are the proposed way
to fulfil it. The [existing architecture guide](../diagrams/README.md) remains the
canonical explanation of the implemented system; these new diagrams describe
this proposed extension only.
