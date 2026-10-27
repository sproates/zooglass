import type { FleetModel, Position, SnapshotState } from "./model.js";

const element = (id: string) => document.getElementById(id)!;
export const coordinates = (p: Position) =>
  `${p.latitude.toFixed(4)}, ${p.longitude.toFixed(4)}`;

/** Render received state only; choosing a row never sends a protocol command. */
export function createFleetView(model: FleetModel) {
  const rows = new Map<
    string,
    {
      button: HTMLButtonElement;
      position: HTMLElement;
      operation: HTMLElement;
      status: HTMLElement;
    }
  >();

  for (const vehicle of model.vehicles) {
    const row = document.createElement("li");
    row.dataset.entityId = vehicle.id;
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = vehicle.name;
    button.setAttribute("aria-controls", "fleet-detail");
    button.addEventListener("click", () => {
      model.select(vehicle.id);
      render();
    });
    const position = document.createElement("p");
    position.className = "fleet-position";
    const operation = document.createElement("p");
    operation.className = "fleet-operation";
    const status = document.createElement("p");
    status.className = "caption fleet-status";
    row.append(button, position, operation, status);
    element("fleet-list").append(row);
    rows.set(vehicle.id, { button, position, operation, status });
  }

  function labelState(target: HTMLElement, state: SnapshotState) {
    target.dataset.state =
      state.current && state.subscribed && model.connection === "connected"
        ? "received"
        : state.received
          ? "retained"
          : "waiting";
  }

  function render() {
    element("connection-status").textContent =
      `ZooGlass ${model.connection}${model.reason ? ` · ${model.reason}` : ""}`;
    for (const vehicle of model.vehicles) {
      const row = rows.get(vehicle.id)!;
      const state = model.get("fleet-state", vehicle.id);
      row.button.setAttribute(
        "aria-pressed",
        String(model.selected === vehicle.id),
      );
      row.position.textContent = state.position
        ? `Position ${state.position.sequence} · ${coordinates(state.position)}`
        : "No position received";
      row.operation.textContent = state.operation
        ? `${state.operation.status} · sequence ${state.operation.sequence}`
        : "No operational status received";
      row.status.textContent = model.status("fleet-state", vehicle.id);
      labelState(row.status, state);
    }

    const selected = model.vehicles.find(
      (vehicle) => vehicle.id === model.selected,
    )!;
    const state = model.get("fleet-state", selected.id);
    const journey = model.get("received-journey", selected.id);
    element("fleet-detail").dataset.entityId = selected.id;
    element("route-title").textContent = `${selected.name} · ${selected.id}`;
    element("current-sequence").textContent = state.position
      ? String(state.position.sequence)
      : "—";
    element("current-coordinates").textContent = state.position
      ? coordinates(state.position)
      : "No position received";
    element("current-operation").textContent = state.operation
      ? `${state.operation.status} · sequence ${state.operation.sequence}`
      : "No operational status received";
    element("position-label").textContent =
      state.current && state.subscribed && model.connection === "connected"
        ? "Current position"
        : "Last received position";
    element("latest-status").textContent = model.status(
      "fleet-state",
      selected.id,
    );
    element("history-status").textContent = model.status(
      "received-journey",
      selected.id,
    );
    labelState(element("latest-status"), state);
    labelState(element("history-status"), journey);
    element("history").replaceChildren(
      ...(journey.positions ?? []).map((p) => {
        const row = document.createElement("li");
        row.dataset.sequence = String(p.sequence);
        row.textContent = `Position ${p.sequence} · ${coordinates(p)}`;
        return row;
      }),
    );
  }

  render();
  return { render };
}
