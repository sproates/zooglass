import { checkpoints, fixtures, orders } from "./fixtures.js";

const byId = (id) => document.getElementById(id);
let selected = orders[0];
let view = "operations";
let checkpoint = 0;
let timer;
let disconnected = false;
const fixtureSelect = byId("fixture");

for (const [value, fixture] of Object.entries(fixtures)) {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = fixture.label;
  fixtureSelect.append(option);
}

function field(value, label, stale = false, previous = false) {
  const muted = value === "Not received";
  return `<div class="field ${muted ? "muted" : ""}"><small>${label}</small><span>${value}</span>${stale ? "<em>Last known · stale</em>" : ""}${previous ? "<em>Previous cycle</em>" : ""}</div>`;
}

function renderOrders() {
  byId("orders").innerHTML = orders
    .map((order) => {
      const data = fixtures[order.fixture];
      return `<button class="order-row ${selected === order ? "selected" : ""}" data-order="${order.id}" aria-pressed="${selected === order}">
      <span class="order-identity"><span class="item-icon ${order.colour}" aria-hidden="true">${order.initials}</span><span><strong>#${order.id} <span class="order-status">${data.order}</span></strong><span class="item-name">${order.item}</span></span></span>
      ${field(data.payment, "Payment", false, order.fixture === "mixed")}
      ${field(data.stock, "Stock", order.fixture === "stale", order.fixture === "mixed")}
      ${field(data.delivery, "Delivery", order.fixture === "courier", order.fixture === "mixed")}
      <span class="row-foot"><span class="state-label ${disconnected ? "offline" : data.tone}">${disconnected ? "Saved snapshot · disconnected" : data.badge}</span><span aria-hidden="true">↗</span></span>
    </button>`;
    })
    .join("");
}

function detailMarkup() {
  const data = disconnected
    ? fixtures.disconnected
    : fixtures[selected.fixture];
  const actual = fixtures[selected.fixture];
  return `<div class="detail-heading"><span class="eyebrow">Selected order</span><span class="detail-number">#${selected.id}</span></div>
    <div class="product-display ${selected.colour}"><svg viewBox="0 0 180 120" fill="none" aria-hidden="true"><path d="M39 40 90 16l51 24v48l-51 25-51-25z"/><path d="m39 40 51 25 51-25M90 65v48M65 28l51 25v22l-15 7V60L51 35"/></svg><span>${selected.item}</span></div>
    <h2>${selected.item}</h2><p class="destination">One item · ${selected.destination} <span>Fictional order</span></p>
    <span class="state-label ${data.tone}">${data.badge}</span><p class="age">${data.age}</p>
    <div class="detail-facts">${field(actual.order, "Order service")}${field(actual.payment, "Payment provider", false, selected.fixture === "mixed")}${field(actual.stock, "Stock service", selected.fixture === "stale", selected.fixture === "mixed")}${field(actual.delivery, "Courier", selected.fixture === "courier", selected.fixture === "mixed")}</div>
    ${actual.couriers ? `<section class="courier-reports" aria-label="Courier reports"><h3>Courier reports</h3><p><strong>Primary · selected</strong><span>${actual.couriers.primary}</span></p><p><strong>Backup · not selected</strong><span>${actual.couriers.backup}</span></p></section>` : ""}
    <div class="explanation"><h3>What this tells us</h3><p>${data.explanation}</p></div>
    <details class="technical"><summary>Sources & view rules</summary><dl><dt>View</dt><dd>order-summary</dd><dt>Entity mapping</dt><dd>payment-${orders.indexOf(selected) + 1} → order-${orders.indexOf(selected) + 1}</dd><dt>Update rule</dt><dd>Latest by source sequence</dd><dt>Courier selection</dt><dd>Primary before backup; no automatic stale fallback</dd><dt>Stock freshness</dt><dd>Stale after 15 seconds</dd></dl>${selected.fixture === "missing" ? "<p>Payment: observed through 3 · watermark 3 · missing 2 (confirmed).</p>" : ""}<p>Illustrative metadata, not a live runtime receipt.</p></details>`;
}

function renderTracking() {
  const data = fixtures[selected.fixture];
  byId("tracking").innerHTML =
    `<div class="tracking-heading"><p class="eyebrow">Tracking view · #${selected.id}</p><h2>Your order, at a glance.</h2><p>${selected.item} · ${selected.destination}</p></div>
    <div class="tracking-picker" aria-label="Choose order">${orders.map((order) => `<button data-order="${order.id}" aria-pressed="${selected === order}">#${order.id}</button>`).join("")}</div>
    ${disconnected ? '<p class="tracking-warning">Viewer disconnected · saved snapshot, not current confirmation.</p>' : ""}
    ${data.trackingReady ? `<div class="tracking-status"><span class="state-label ${data.tone}">${data.badge === "Payment delivery gap" ? "Tracking contributions received" : data.badge}</span><h3>${data.order}</h3><p>${selected.fixture === "mixed" ? "New cycle. Stock and delivery below belong to the previous cycle." : "The latest contributions received for this order."}</p></div><div class="tracking-facts">${field(data.order, "Order")}${field(data.stock, "Stock", selected.fixture === "stale", selected.fixture === "mixed")}${field(data.delivery, "Delivery", selected.fixture === "courier", selected.fixture === "mixed")}</div>` : '<div class="waiting-state"><span class="waiting-symbol" aria-hidden="true">…</span><h3>Waiting for tracking information</h3><p>This view waits for both order and stock contributions. No tracking values are released yet.</p><span class="state-label quiet">Missing required contribution: stock</span></div>'}
    <div class="tracking-caption"><strong>A different view of the same events.</strong><p>Tracking requires order and stock contributions. Payment is not included. This smaller view is not an access-control boundary.</p></div>`;
}

function render() {
  const focusedOrder = document.activeElement?.dataset.order;
  const focusedList = document.activeElement?.closest("#tracking")
    ? "tracking"
    : "orders";
  renderOrders();
  byId("desktop-detail").innerHTML = detailMarkup();
  byId("mobile-detail-body").innerHTML = detailMarkup();
  renderTracking();
  document.body.dataset.view = view;
  fixtureSelect.value = disconnected ? "disconnected" : selected.fixture;
  document
    .querySelectorAll("button[data-view]")
    .forEach((button) =>
      button.setAttribute("aria-pressed", button.dataset.view === view),
    );
  byId("tracking").hidden = view !== "tracking";
  byId("mobile-detail").setAttribute(
    "aria-label",
    `Order #${selected.id} details`,
  );
  if (focusedOrder) {
    byId(focusedList)
      .querySelector(`[data-order="${focusedOrder}"]`)
      ?.focus({ preventScroll: true });
  }
}

function selectOrder(id) {
  selected = orders.find((order) => order.id === id);
  render();
  if (view === "operations" && matchMedia("(max-width: 760px)").matches) {
    byId("mobile-detail").showModal();
  }
}

function applyFixture(name) {
  disconnected = name === "disconnected";
  if (!disconnected) selected.fixture = name;
  byId("notice").textContent = disconnected
    ? fixtures[name].notice
    : `Order ${selected.id}: ${fixtures[name].notice}`;
  render();
}

function stop() {
  clearInterval(timer);
  timer = undefined;
  byId("play").textContent = "Play";
}

function showCheckpoint() {
  byId("checkpoint-label").textContent =
    `${checkpoint + 1} / ${checkpoints.length} · ${fixtures[checkpoints[checkpoint]].label}`;
  byId("step").disabled = checkpoint === checkpoints.length - 1;
  byId("play").disabled = checkpoint === checkpoints.length - 1;
}

function step() {
  if (checkpoint < checkpoints.length - 1) checkpoint += 1;
  selected = orders[0];
  applyFixture(checkpoints[checkpoint]);
  if (checkpoint === checkpoints.length - 1) stop();
  showCheckpoint();
}

byId("orders").addEventListener("click", (event) => {
  const row = event.target.closest("[data-order]");
  if (row) selectOrder(row.dataset.order);
});
byId("tracking").addEventListener("click", (event) => {
  const button = event.target.closest("[data-order]");
  if (button) selectOrder(button.dataset.order);
});
document.querySelectorAll("button[data-view]").forEach((button) =>
  button.addEventListener("click", () => {
    view = button.dataset.view;
    render();
  }),
);
fixtureSelect.addEventListener("change", () => {
  stop();
  const name = fixtureSelect.value;
  applyFixture(name);
  checkpoint = checkpoints.indexOf(name);
  showCheckpoint();
});
byId("mode").addEventListener("change", () => {
  stop();
  const interactive = byId("mode").value === "interactive";
  byId("playback").hidden = !interactive;
  if (interactive) {
    checkpoint = 0;
    selected = orders[0];
    applyFixture(checkpoints[0]);
    showCheckpoint();
  }
});
byId("step").addEventListener("click", step);
byId("reset").addEventListener("click", () => {
  stop();
  checkpoint = 0;
  selected = orders[0];
  applyFixture(checkpoints[0]);
  showCheckpoint();
});
byId("play").addEventListener("click", () => {
  if (timer) return stop();
  byId("play").textContent = "Pause";
  timer = setInterval(step, 3000);
});
byId("mobile-detail").addEventListener("close", () => {
  byId("orders")
    .querySelector(`[data-order="${selected.id}"]`)
    ?.focus({ preventScroll: true });
});
window.addEventListener("pagehide", stop);
render();
showCheckpoint();
