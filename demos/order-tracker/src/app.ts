import { connectControls } from "./controls.js";
import { OrderModel } from "./model.js";
import { connectOrders } from "./connection.js";
import { renderOrders, selectOrder, selectView } from "./view.js";

const model = new OrderModel();
let frame = 0;
function redraw() {
  if (!frame)
    frame = requestAnimationFrame(() => {
      frame = 0;
      renderOrders(model);
    });
}
renderOrders(model);
const openConnection = () =>
  connectOrders(
    (snapshot) => {
      model.accept(snapshot);
      redraw();
    },
    (state) => {
      if (state === "connecting") model.beginConnection();
      model.connected = state === "connected";
      model.connection =
        state === "connected"
          ? "Receiving live snapshots"
          : state === "connecting"
            ? "Connecting · awaiting fresh snapshots"
            : state === "disconnected"
              ? "Disconnected · saved snapshots · retrying"
              : state;
      redraw();
    },
    (event) =>
      document.dispatchEvent(
        new CustomEvent("order-observation", { detail: event }),
      ),
  );
let connection = openConnection();
let generation: number | undefined;
let waitingForRun = false;
if (document.body.dataset.interactive === "true")
  connectControls((next, available) => {
    if (generation !== next) {
      generation = next;
      connection.close();
      model.snapshots.clear();
      model.beginConnection();
      model.connection = "Resetting · awaiting fresh snapshots";
      waitingForRun = true;
      redraw();
    }
    if (available && waitingForRun) {
      waitingForRun = false;
      connection = openConnection();
    }
  });
for (const root of ["orders", "tracking"])
  document.getElementById(root)!.addEventListener("click", (event) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>(
      "[data-order]",
    );
    if (row) selectOrder(model, row.dataset.order!);
  });
document
  .querySelectorAll<HTMLButtonElement>("button[data-view]")
  .forEach((button) =>
    button.addEventListener("click", () =>
      selectView(model, button.dataset.view!),
    ),
  );
document
  .getElementById("mobile-detail")!
  .addEventListener("close", () =>
    document
      .querySelector<HTMLElement>(`#orders [data-order="${model.selected}"]`)
      ?.focus({ preventScroll: true }),
  );

// This separate, bounded simulator feed is explanatory, never used to derive view state.
let polling: ReturnType<typeof setTimeout> | undefined;
let request: AbortController | undefined;
let active = true;
async function activity() {
  if (!active || document.hidden) return;
  request = new AbortController();
  const timeout = setTimeout(() => request?.abort(), 5000);
  try {
    const response = await fetch("/activity.json", { signal: request.signal });
    if (!response.ok) throw new Error("Activity unavailable");
    const notices: { text: string }[] = await response.json();
    document.getElementById("notice")!.textContent =
      notices.at(-1)?.text ?? "Waiting for simulated delivery events.";
  } catch {
    if (active && !document.hidden)
      document.getElementById("notice")!.textContent =
        "Simulator notices unavailable; view data uses a separate connection.";
  } finally {
    clearTimeout(timeout);
    request = undefined;
    if (active && !document.hidden) polling = setTimeout(activity, 3000);
  }
}
function stopActivity() {
  clearTimeout(polling);
  request?.abort();
}
document.addEventListener("visibilitychange", () => {
  stopActivity();
  if (!document.hidden && !request) void activity();
});
window.addEventListener("pagehide", () => {
  active = false;
  stopActivity();
  cancelAnimationFrame(frame);
  frame = 0;
});
window.addEventListener("pageshow", () => {
  active = true;
  if (!request) {
    clearTimeout(polling);
    void activity();
  }
});
void activity();
document.getElementById("startup")!.hidden = true;
