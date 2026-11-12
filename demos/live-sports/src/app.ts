import { connectSports } from "./connection.js";
import { SportsModel, matchIds, type Layout } from "./model.js";
import { renderSports } from "./view.js";

const model = new SportsModel();
let frame = 0;
function redraw() {
  if (!frame)
    frame = requestAnimationFrame(() => {
      frame = 0;
      renderSports(model);
    });
}
renderSports(model);
connectSports(
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
      new CustomEvent("sports-observation", { detail: event }),
    ),
);

document.getElementById("matches")!.addEventListener("click", (event) => {
  const card = (event.target as HTMLElement).closest<HTMLElement>(
    "[data-match]",
  );
  if (!card || !matchIds.includes(card.dataset.match!)) return;
  model.selected = card.dataset.match!;
  renderSports(model);
  if (
    matchMedia("(max-width: 650px)").matches &&
    model.layout !== "scoreboard"
  ) {
    const detail = document.getElementById(
      model.layout === "comparison" ? "comparison" : "match-detail",
    )!;
    detail.focus({ preventScroll: true });
    detail.scrollIntoView();
  }
});
document.addEventListener("click", (event) => {
  if (!(event.target as HTMLElement).closest("[data-back-to-matches]")) return;
  const card = document.querySelector<HTMLElement>(
    `[data-match="${model.selected}"]`,
  )!;
  card.focus({ preventScroll: true });
  card.scrollIntoView({ block: "center" });
});
document.querySelectorAll<HTMLButtonElement>("[data-view]").forEach((button) =>
  button.addEventListener("click", () => {
    model.layout = button.dataset.view as Layout;
    renderSports(model);
  }),
);

// Explanatory simulator notices are separate from view data and never derive scores.
let polling: ReturnType<typeof setTimeout> | undefined;
let request: AbortController | undefined;
let active = true;
async function activity() {
  if (!active || document.hidden || request) return;
  const current = new AbortController();
  request = current;
  const timeout = setTimeout(() => current.abort(), 5000);
  const notice = document.getElementById("notice")!;
  try {
    const response = await fetch("/activity.json", { signal: current.signal });
    if (!response.ok) throw new Error("Activity unavailable");
    const report: {
      state: string;
      error?: string;
      notices: { text: string }[];
    } = await response.json();
    if (!active || document.hidden) return;
    const runStatus = document.getElementById("run-status")!;
    runStatus.hidden = report.state !== "failed";
    runStatus.textContent =
      report.state === "failed"
        ? "Simulation stopped. The next checkpoint could not complete. Restart the demo to try again; terminal output contains the details."
        : "";
    notice.textContent =
      report.notices.at(-1)?.text ?? "Waiting for simulated delivery events.";
    notice.classList.toggle("run-failure", report.state === "failed");
  } catch {
    if (active && !document.hidden)
      notice.textContent =
        "Simulator notices unavailable; view data uses a separate connection.";
  } finally {
    clearTimeout(timeout);
    request = undefined;
    if (active && !document.hidden) polling = setTimeout(activity, 2000);
  }
}
function stopActivity() {
  clearTimeout(polling);
  request?.abort();
}
document.addEventListener("visibilitychange", () => {
  stopActivity();
  if (!document.hidden) void activity();
});
window.addEventListener("pagehide", () => {
  active = false;
  stopActivity();
  cancelAnimationFrame(frame);
  frame = 0;
});
window.addEventListener("pageshow", () => {
  active = true;
  clearTimeout(polling);
  void activity();
});
void activity();
document.getElementById("startup")!.hidden = true;
