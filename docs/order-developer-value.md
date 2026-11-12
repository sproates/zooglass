# What the Order demo delegates to ZooGlass

The Order desk combines five independently reporting sources into an operations
summary and a smaller tracking view. The application supplies the relationships
and policies; ZooGlass maintains the resulting snapshots. The browser renders
those snapshots instead of repeating the reconciliation rules.

The [acceptance record](verification/2026-11-12-order-acceptance.md) links the
observable evidence and limits. This is a responsibility comparison, not a claim
about engineering hours saved or production readiness.

## An equally scoped custom implementation

A custom service could implement the same behaviour. For this example it would
need durable state as well as live delivery, because restart and duplicate
recognition are part of the demonstrated scope.

| Work | An equally scoped custom service would own | With ZooGlass |
| --- | --- | --- |
| Join different entity keys | Map payment, reservation and shipment keys onto orders, including unknown-key outcomes. | Configure `lookupEntity` mappings per view; order publications use `envelopeEntity`. |
| Keep independent contributions | Route events into separate fields and compare revisions within each source's sequence domain. | Configure fields with `latestBySequence`; delayed order revision 2 cannot replace revision 3. |
| Select a courier | Retain both candidates and apply explicit authority without comparing unrelated sequences. | Configure `sourcePriority`; the primary stays selected when stale and the backup reports again. |
| Publish different views | Maintain a partial operations view and a tracking view that initially waits for order and stock. | Use `publishPartial` and `requireContributions` on two definitions. Tracking has no payment field. |
| Explain missing reports | Track received ranges, watermarks, admission floors and missing-range classifications. | Configure contiguous progress on orders, payments and inventory. The service reports the permanent payment gap; it does not invent the lost value. |
| Explain old information | Persist receipt ages, schedule expiry and publish status-only changes. | Configure `receiptAge`. The Order page reads freshness from snapshots rather than computing source health. |
| Recover durable state | Commit view state, source identities, retained receipts, candidates and progress together; recover without duplicate effects. | SQLite storage and the identity window provide the checked restart and exact-retry behaviour. |
| Reconnect a viewer | Coordinate first snapshots and subsequent updates, bound delivery queues and remove slow recipients. | Subscribe to a view/entity pair; the service sends current state. The browser still owns reconnect policy. |
| Enforce view access | Ask the authority for scoped decisions, revalidate access and stop unauthorised delivery. | The protected acceptance uses ZooGlass enforcement; the authority supplies decisions and the client clears protected data on loss. |

## What the application still owns

- Source adapters, payload meaning, event identity, epochs and increasing source
  sequences. A retry must preserve the original content; a producer cannot safely
  restart its counters against the same store.
- Entity relationships and the decision that primary courier data is authoritative.
  Neither mappings nor priorities are discovered automatically.
- Payment, stock and fulfilment decisions. A partial summary or a satisfied
  first-contribution gate does not mean an order is ready to ship.
- UI selection, layout, accessible interactions, reconnect behaviour, labels and
  the list of subscribed identities. “Previous cycle” explains synthetic slot
  reuse; it is a demo presentation rule.
- Authentication/session issuance, access policy, credential handling, deployment,
  certificates and operational ownership. The finite protected fixture is not a
  production identity provider or login application.
- Simulator scheduling and fault injection. Step/Play/Pause/Reset, the notice feed
  and browser recovery observations belong to Workbench, not a production source.

## Add an order, a source or a view

The runnable [configuration extension test](../workbench/test/scenarios/order-extension.test.ts)
starts the real prepared service with a seventh order, a new packing source and
an `order-dispatch` view. Its expected values are literal test data, independent
of the producer's event builder. It changes no Java or production projection code.

**Another order.** `orders` already uses the envelope entity ID, so `order-7` needs
no per-order projection class. The test adds `reservation-7 → order-7` to both
existing inventory lookup maps and raises the tracking pending-entity limit to 7.
The summary immediately contains the order; tracking waits until stock arrives.
For a fully populated seventh demo slot, also add the payment and both courier
lookup keys, its product data and its schedule. Update `orderIds` in the producer
contracts and browser model, the six-slot schedule/checkpoints and related tests.
The shipped browser intentionally remains a six-order demo; the extension test
uses the service interfaces and is not an unimplemented UI option.

**Another source.** The test declares `packing` with epoch `run`, maps `parcel-7`
to `order-7`, and publishes `packing.state` through the existing event endpoint.
An application must supply that adapter and its identity/retry contract. If the
new source competes for an existing field, add it to that field's input and
priority lists; this example instead gives packing its own field in a third view.
Increase configured stream capacity if the intended population requires it.

**Another view.** `order-dispatch` selects `order.state` and `packing.state` using
`latestBySequence`, then requires both contributions before publication. It waits
after the order arrives, becomes ready when packing arrives, and leaves summary
and tracking values unchanged. Add client subscriptions and rendering if users
need that view. These are startup definitions, not a dynamic editor or backfill
claim. A new strategy outside the implemented policies could still require core
service changes.

## Changes actually made for Order delivery

The programme added Order configuration, a five-source simulator and its checked
walkthrough, the Order UI, and acceptance fixtures. Shared integration changes
were necessary: the Workbench launcher accepts explicit runtime configuration,
the existing subscription client exposes full snapshot metadata while preserving
vehicle callbacks, and prepared checkpoints reuse the shared playback controller.
The protected test harness also accepts Order assets and resource grants.

The two Order views required **no new ZooGlass core projection or Java strategy**.
The extension fixture provides a concrete third-view example using those same
contracts. This avoids application-specific reconciliation code in the page;
it does not remove the source integration, policy or product work listed above.

See the [configuration](../workbench/src/demos/orders/configuration.ts),
[source schedule](../workbench/docs/order-sources.md),
[browser source map](../demos/order-tracker/docs/source-map.md) and
[Workbench ownership map](../workbench/docs/source-map.md#interactive-order-walkthrough).
