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

type ViewId = "live-map" | "trip-history";

type ViewState = {
  subscribed: boolean;
  received: boolean;
  current: boolean;
  subscribing: boolean;
};

const views: Record<ViewId, ViewState> = {
  "live-map": {
    subscribed: false,
    received: false,
    current: false,
    subscribing: false,
  },
  "trip-history": {
    subscribed: false,
    received: false,
    current: false,
    subscribing: false,
  },
};

let connection:
  "disconnected" | "connecting" | "connected" | "reconnecting" | "error" =
  "disconnected";

function renderStatus() {
  for (const id of ["live-map", "trip-history"] as const) {
    const state = views[id];
    let text: string;

    if (state.current && state.subscribed && connection === "connected") {
      text =
        id === "live-map"
          ? "Latest snapshot received"
          : history.length
            ? `${history.length} received position${history.length === 1 ? "" : "s"}`
            : "No positions received · empty snapshot";
    } else if (state.received) {
      text = state.subscribed
        ? "Last received · waiting for a fresh snapshot"
        : "Last received · not subscribed";

      if (connection !== "connected")
        text = `Last received · ${connection === "error" ? "connection failed" : connection}`;
    } else if (connection === "error")
      text = "No snapshot received · connection failed";
    else if (state.subscribed) text = "Subscribed · waiting for first snapshot";
    else if (state.subscribing) text = "Subscribing…";
    else text = "Not subscribed · no snapshot received";

    const target = element(
      id === "live-map" ? "latest-status" : "history-status",
    );

    target.textContent = text;
    target.dataset.state =
      state.current && state.subscribed && connection === "connected"
        ? "received"
        : state.received
          ? "retained"
          : "waiting";
  }

  if (latest) {
    const current =
      views["live-map"].current &&
      views["live-map"].subscribed &&
      connection === "connected";
    element("position-label").textContent = current
      ? "Current position"
      : "Last received position";
    element("route-description").textContent =
      `${current ? "Latest" : "Last received"} position ${latest.sequence} at ${coordinates(latest)}. Connecting received points does not establish the route travelled.`;
  }
}

export function setConnection(state: typeof connection, reason?: string) {
  connection = state;

  if (state !== "connected")
    for (const view of Object.values(views)) {
      view.subscribed = false;
      view.subscribing = false;
      view.current = false;
    }

  const labels = {
    disconnected: "ZooGlass disconnected",
    connecting: "Connecting to ZooGlass…",
    reconnecting: "ZooGlass interrupted · reconnecting…",
    connected: "Connected to ZooGlass",
    error: "ZooGlass connection failed",
  };

  element("connection-status").textContent = reason
    ? `${labels[state]} · ${reason}`
    : labels[state];
  renderStatus();
}

export function subscriptionState(
  viewId: string,
  state: "pending" | "subscribed" | "unsubscribed",
) {
  if (!(viewId in views)) throw new Error("Unknown vehicle view.");

  const view = views[viewId as ViewId];

  view.subscribing = state === "pending";
  view.subscribed = state === "subscribed";
  view.current = false;
  renderStatus();
}

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
    views["live-map"].received = true;
    views["live-map"].current = true;
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
    views["trip-history"].received = true;
    views["trip-history"].current = true;
  } else {
    throw new Error("Invalid vehicle snapshot.");
  }

  draw();
  renderStatus();
}

/** A replacement run begins with no retained data from the previous service. */
export function resetView() {
  latest = undefined;
  history = [];
  for (const view of Object.values(views)) {
    view.subscribed = false;
    view.received = false;
    view.current = false;
    view.subscribing = false;
  }
  element("current-sequence").textContent = "—";
  element("current-coordinates").textContent = "No position received";
  element("history").replaceChildren();
  element("route-description").textContent = "Waiting for received positions.";
  setConnection("disconnected");
  draw();
}
