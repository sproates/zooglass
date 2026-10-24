export interface Position {
  sequence: number;
  latitude: number;
  longitude: number;
}
function position(value: unknown): value is Position {
  if (!value || typeof value !== "object") return false;
  const p = value as Position;
  return (
    [p.sequence, p.latitude, p.longitude].every(Number.isFinite) &&
    Math.abs(p.latitude) <= 90 &&
    Math.abs(p.longitude) <= 180
  );
}
const element = (id: string) => document.getElementById(id)!;
let latest: Position | undefined;
let history: Position[] = [];
// Fixed schematic bounds for this finite route, not a geographic map.
export function point(p: Position) {
  return {
    x: 60 + ((p.longitude + 0.35) / 0.4) * 480,
    y: 270 - ((p.latitude - 50.95) / 0.4) * 220,
  };
}
function coordinates(p: Position) {
  return `${p.latitude.toFixed(3)}, ${p.longitude.toFixed(3)}`;
}
function draw() {
  element("route-line").setAttribute(
    "points",
    history
      .map((p) => {
        const { x, y } = point(p);
        return `${x},${y}`;
      })
      .join(" "),
  );
  const marker = element("vehicle-marker");
  marker.setAttribute("visibility", latest ? "visible" : "hidden");
  if (latest) {
    const { x, y } = point(latest);
    marker.setAttribute("cx", String(x));
    marker.setAttribute("cy", String(y));
    element("route-description").textContent =
      `Latest position ${latest.sequence} at ${coordinates(latest)}. Connecting received points does not establish the route travelled.`;
  }
}
/** Only call with a snapshot received from the app's ZooGlass socket. */
export function receiveView(viewId: string, entityId: string, data: unknown) {
  if (entityId !== "car-17" || !data || typeof data !== "object")
    throw new Error("Unexpected vehicle snapshot.");
  const fields = data as Record<string, unknown>;
  if (viewId === "live-map" && position(fields.position)) {
    latest = fields.position;
    element("current-sequence").textContent = String(latest.sequence);
    element("current-coordinates").textContent = coordinates(latest);
    element("latest-status").textContent = "Latest snapshot received";
  } else if (
    viewId === "trip-history" &&
    Array.isArray(fields.positions) &&
    fields.positions.every(position)
  ) {
    history = fields.positions;
    const rows = history.map((p) => {
      const row = document.createElement("li");
      row.dataset.sequence = String(p.sequence);
      row.textContent = `Position ${p.sequence} · ${coordinates(p)}`;
      return row;
    });
    element("history").replaceChildren(...rows);
    element("history-status").textContent =
      `${history.length} received position${history.length === 1 ? "" : "s"}`;
  } else {
    throw new Error("Invalid vehicle snapshot.");
  }
  draw();
}
export function connectionStatus(text: string) {
  element("connection-status").textContent = text;
}
