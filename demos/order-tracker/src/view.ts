import {
  OrderModel,
  orderIds,
  fact,
  words,
  escape,
  type ViewSnapshot,
  type OrderView,
} from "./model.js";
const byId = (id: string) => document.getElementById(id)!;
const names: Record<string, string> = {
  order: "Order",
  payment: "Payment",
  inventory: "Stock",
  delivery: "Delivery",
};
const sources: Record<string, string> = {
  orders: "Order service",
  payments: "Payment provider",
  inventory: "Stock service",
  "courier-primary": "Primary courier",
  "courier-backup": "Backup courier",
};
const colours = ["sand", "blue", "clay", "sage", "mauve", "sand"];

function field(
  snapshot: ViewSnapshot | undefined,
  name: string,
  showReceived = false,
) {
  const value = fact(snapshot, name);
  const selectedCycle = fact(snapshot, "order")?.cycle;
  const previous = value && selectedCycle && value.cycle < selectedCycle;
  const status = snapshot?.status.fields[name];
  const source = snapshot?.provenance[name];
  return `<div class="field ${value ? "" : "muted"}" data-field="${name}"><small>${names[name]}</small><span>${escape(value ? words(value.status) : "Not received")}</span>${status?.freshness === "stale" ? "<em>Last known · stale</em>" : ""}${previous ? `<em>Previous cycle · ${escape(value.cycle)}</em>` : ""}${source ? `<small class="source">${escape(sources[source.sourceId] ?? source.sourceId)}</small>` : ""}${showReceived && status?.receivedAtMillis ? `<small>Received ${escape(new Date(status.receivedAtMillis).toLocaleTimeString())}</small>` : ""}</div>`;
}
function badge(snapshot: ViewSnapshot | undefined, saved: boolean) {
  if (!snapshot)
    return '<span class="state-label quiet">Awaiting snapshot</span>';
  if (saved)
    return '<span class="state-label offline">Saved snapshot · updates unavailable</span>';
  if (snapshot.status.publication === "waiting")
    return '<span class="state-label quiet">Waiting for required contributions</span>';
  if (
    Object.values(snapshot.status.fields).some(
      (field) => field.freshness === "stale",
    )
  )
    return '<span class="state-label warn">Stale contribution · last known</span>';
  if (
    Object.values(snapshot.status.inputs).some(
      (input) => input.missingRanges.length,
    )
  )
    return '<span class="state-label warn">Source delivery gap</span>';
  const cycle = fact(snapshot, "order")?.cycle;
  if (
    cycle &&
    Object.keys(snapshot.data).some(
      (name) => (fact(snapshot, name)?.cycle ?? cycle) < cycle,
    )
  )
    return '<span class="state-label quiet">Previous-cycle contributions</span>';
  return `<span class="state-label ${snapshot.status.publication === "ready" ? "good" : "quiet"}">${snapshot.status.publication === "ready" ? "Contributions received" : "Partial information"}</span>`;
}
function evidence(snapshot: ViewSnapshot | undefined) {
  if (!snapshot) return "";
  return `<details class="technical" data-disclosure="evidence"><summary>Sources & view rules</summary><p>${escape(snapshot.viewId)} · version ${snapshot.version}</p><dl>${Object.entries(
    snapshot.provenance,
  )
    .map(
      ([name, source]) =>
        `<dt>${names[name] ?? escape(name)}</dt><dd>${escape(source.sourceId)} / ${escape(source.sourceEntityId)} · publication ${escape(snapshot.publicationSequences[name]?.join(", "))}</dd>`,
    )
    .join("")}</dl>${Object.entries(snapshot.status.inputs)
    .map(
      ([source, input]) =>
        `<p>${escape(source)}: ${escape(input.completeness)} · observed through ${input.observedThrough ?? "not observed"} · watermark ${input.watermarkThrough ?? "none"}${input.missingRanges.map((gap) => `<br>Missing ${gap.from}–${gap.through} (${escape(gap.status)})`).join("")}</p>`,
    )
    .join(
      "",
    )}<p>Latest by source sequence. Primary courier before backup; stale does not select backup. Receipt-age freshness: 15 seconds. Tracking requires order and stock, not payment approval.</p></details>`;
}
function details(model: OrderModel) {
  const data = model.get("order-summary", model.selected);
  const order = fact(data, "order");
  const index = orderIds.indexOf(model.selected);
  const title = order?.items?.join(", ") ?? "Awaiting order details";
  const delivery = data?.status.fields.delivery;
  return `<div class="detail-heading"><span class="eyebrow">Selected order</span><span class="detail-number">${escape(order?.reference ?? model.selected)}</span></div>
    <div class="product-display ${colours[index]}"><svg viewBox="0 0 180 120" fill="none" aria-hidden="true"><path d="M39 40 90 16l51 24v48l-51 25-51-25z"/><path d="m39 40 51 25 51-25M90 65v48M65 28l51 25v22l-15 7V60L51 35"/></svg><span>${escape(title)}</span></div>
    <h2>${escape(title)}</h2><p class="destination">Synthetic slot ${index + 1} · cycle ${order?.cycle ?? "not received"}</p>
    ${badge(data, model.saved("order-summary", model.selected))}
    <div class="detail-facts">${Object.keys(names)
      .map((name) => field(data, name, true))
      .join("")}</div>
    ${delivery?.receivedAtMillis ? `<p class="age">Selected courier received at ${escape(new Date(delivery.receivedAtMillis).toLocaleTimeString())} · ${escape(delivery.freshness)}</p>` : ""}
    <div class="explanation"><h3>Independent reports, one view.</h3><p>Each source contributes separately. Missing reports are unknown, not failures. A stale courier value remains selected by priority; it is not current confirmation.</p><p>Six synthetic slots repeat. Earlier-cycle values stay labelled until replaced; required contributions do not make a new cycle atomic.</p></div>${evidence(data)}`;
}

/** Keep disclosures, focus and modal scroll stable while replacing supplied snapshots. */
export function renderOrders(model: OrderModel) {
  const active = document.activeElement as HTMLElement | null;
  const focusedOrder = active?.dataset.order;
  const focusedRoot = active?.closest("#tracking") ? "tracking" : "orders";
  const disclosure = active?.closest("details")?.dataset.disclosure;
  const detailRoot = active?.closest("#mobile-detail")
    ? "mobile-detail-body"
    : active?.closest("#tracking")
      ? "tracking"
      : "desktop-detail";
  const expanded = [
    ...document.querySelectorAll<HTMLDetailsElement>(
      "details[data-disclosure][open]",
    ),
  ].map((el) => [el.parentElement!.id, el.dataset.disclosure]);
  const dialog = byId("mobile-detail") as HTMLDialogElement;
  const scroll = dialog.scrollTop;
  byId("orders").innerHTML = orderIds
    .map((id, index) => {
      const data = model.get("order-summary", id);
      const order = fact(data, "order");
      return `<button class="order-row ${id === model.selected ? "selected" : ""}" data-order="${id}" aria-pressed="${id === model.selected}"><span class="order-identity"><span class="item-icon ${colours[index]}" aria-hidden="true">${index + 1}</span><span><strong>${escape(order?.reference ?? `Slot ${index + 1}`)} <span class="order-status">${escape(order ? words(order.status) : "Not received")}</span></strong><span class="item-name">${escape(order?.items?.join(", ") ?? "Awaiting order")}</span></span></span>${["payment", "inventory", "delivery"].map((name) => field(data, name)).join("")}<span class="row-foot">${badge(data, model.saved("order-summary", id))}<span aria-hidden="true">↗</span></span></button>`;
    })
    .join("");
  byId("desktop-detail").innerHTML = details(model);
  byId("mobile-detail-body").innerHTML = details(model);
  dialog.setAttribute("aria-label", `${model.selected} details`);
  const tracking = model.get("order-tracking", model.selected);
  byId("tracking").innerHTML =
    `<div class="tracking-heading"><p class="eyebrow">Tracking · ${escape(model.selected)}</p><h2>Your order, at a glance.</h2></div><div class="tracking-picker" aria-label="Choose order">${orderIds.map((id, index) => `<button data-order="${id}" aria-pressed="${id === model.selected}">Slot ${index + 1}</button>`).join("")}</div>${badge(tracking, model.saved("order-tracking", model.selected))}${!tracking || tracking.status.publication === "waiting" ? `<div class="waiting-state"><h3>Waiting for tracking information</h3><p>Required contributions: ${escape(tracking?.status.missingRequiredFields.map((name) => names[name] ?? name).join(", ") ?? "awaiting snapshot")}.</p><p>Tracking values are withheld until order and stock have contributed.</p></div>` : `<div class="tracking-facts">${["order", "inventory", "delivery"].map((name) => field(tracking, name)).join("")}</div>`}<div class="tracking-caption"><strong>A different view of the same events.</strong><p>Direct order-tracking subscription. Payment is absent by definition. This smaller view is not an access-control boundary.</p></div>${evidence(tracking)}`;
  document.body.dataset.view =
    model.view === "order-summary" ? "operations" : "tracking";
  byId("tracking").hidden = model.view !== "order-tracking";
  document
    .querySelectorAll<HTMLButtonElement>("button[data-view]")
    .forEach((button) =>
      button.setAttribute(
        "aria-pressed",
        String(button.dataset.view === document.body.dataset.view),
      ),
    );
  byId("connection").textContent = model.connection;
  for (const [root, name] of expanded) {
    const element = document.querySelector<HTMLDetailsElement>(
      `#${root} details[data-disclosure="${name}"]`,
    );
    if (element) element.open = true;
  }
  if (focusedOrder)
    byId(focusedRoot)
      .querySelector<HTMLElement>(`[data-order="${focusedOrder}"]`)
      ?.focus({ preventScroll: true });
  else if (disclosure)
    byId(detailRoot)
      .querySelector<HTMLElement>(
        `details[data-disclosure="${disclosure}"] summary`,
      )
      ?.focus({ preventScroll: true });
  dialog.scrollTop = scroll;
}
export function selectOrder(model: OrderModel, id: string) {
  if (!orderIds.includes(id)) return;
  model.selected = id;
  renderOrders(model);
  if (
    model.view === "order-summary" &&
    matchMedia("(max-width: 760px)").matches
  )
    (byId("mobile-detail") as HTMLDialogElement).showModal();
}
export function selectView(model: OrderModel, view: string) {
  model.view = (
    view === "tracking" ? "order-tracking" : "order-summary"
  ) as OrderView;
  renderOrders(model);
}
