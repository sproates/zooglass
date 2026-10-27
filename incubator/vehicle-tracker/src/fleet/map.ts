import * as L from "/vendor/leaflet/leaflet-src.esm.js";
import { createMapControls } from "./map-controls.js";
import { addMapTiles, type MapConfiguration } from "./map-tiles.js";
import type { FleetModel } from "./model.js";

/** Geographic presentation of received facts; no interpolation or road matching. */
export function createFleetMap(
  model: FleetModel,
  configuration: MapConfiguration,
  select: (entityId: string) => void,
) {
  const map = L.map("fleet-map", {
    scrollWheelZoom: false,
    attributionControl: false,
  }).setView([36.141, -5.3535], 16);
  addMapTiles(map, configuration);
  const controls = createMapControls(map, model);

  const markers = new Map<string, L.Marker>();
  const route = L.polyline([], {
    color: "#16664f",
    weight: 4,
    interactive: false,
    className: "fleet-received-route",
    smoothFactor: 0,
  }).addTo(map);
  const routeStatus = document.getElementById("map-status")!;

  function render() {
    controls.render();
    for (const vehicle of model.vehicles) {
      const state = model.get("fleet-state", vehicle.id);
      const position = state.position;
      let marker = markers.get(vehicle.id);
      if (!position) {
        marker?.remove();
        markers.delete(vehicle.id);
        continue;
      }
      if (!marker) {
        const icon = document.createElement("div");
        icon.className = "vehicle-map-symbol";
        icon.innerHTML =
          '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 9 7 4h10l2 5 2 2v8h-3v-3H6v3H3v-8zm2 0h10l-1-3H8zm-1 3v2h3v-2zm9 0v2h3v-2z" fill="currentColor"/></svg>';
        const label = document.createElement("span");
        label.textContent = vehicle.name.replace(/^Vehicle /, "");
        icon.append(label);
        marker = L.marker([position.latitude, position.longitude], {
          title: vehicle.name,
          keyboard: true,
          autoPanOnFocus: false,
          icon: L.divIcon({
            html: icon,
            className: "vehicle-map-marker",
            iconSize: [52, 44],
            iconAnchor: [26, 22],
          }),
        }).addTo(map);
        marker.on("click", () => select(vehicle.id));
        marker.getElement()!.addEventListener("keydown", (event) => {
          if (event.key === " " || event.key === "Enter") {
            event.preventDefault();
            select(vehicle.id);
          }
        });
        markers.set(vehicle.id, marker);
      }
      marker.setLatLng([position.latitude, position.longitude]);
      const element = marker.getElement()!;
      element.setAttribute("aria-label", `Select ${vehicle.name} on map`);
      element.setAttribute(
        "aria-pressed",
        String(vehicle.id === model.selected),
      );
      element.dataset.entityId = vehicle.id;
      element.classList.toggle("selected", vehicle.id === model.selected);
      element.classList.toggle(
        "retained",
        !(
          state.current &&
          state.subscribed &&
          model.connection === "connected"
        ),
      );
      marker.setZIndexOffset(vehicle.id === model.selected ? 1000 : 0);
    }

    const history = model.get("received-journey", model.selected);
    route.setLatLngs(
      (history.positions ?? []).map((p) => [p.latitude, p.longitude]),
    );
    const retained = !(
      history.current &&
      history.subscribed &&
      model.connection === "connected"
    );
    route.setStyle({ dashArray: retained ? "6 6" : undefined });
    const vehicle = model.vehicles.find((item) => item.id === model.selected)!;
    routeStatus.textContent = `${vehicle.name}: ${model.status("received-journey", model.selected)}. Lines connect received coordinates; they are not verified road journeys.`;
  }

  render();
  return { render };
}
