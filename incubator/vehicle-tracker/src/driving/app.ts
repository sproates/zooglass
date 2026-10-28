import * as L from "/vendor/leaflet/leaflet-src.esm.js";
import { addMapTiles, type MapConfiguration } from "../fleet/map-tiles.js";

interface Car {
  id: string;
  name: string;
  roads: string[];
}
interface Position {
  sequence: number;
  latitude: number;
  longitude: number;
  observedAt: number;
}
const cars: Car[] = await fetch("/cars.json").then((response) =>
  response.json(),
);
const configuration: MapConfiguration = await fetch("/map-config.json").then(
  (response) => response.json(),
);
const map = L.map("map", { attributionControl: false }).setView(
  [36.146, -5.355],
  15,
);
const tiles = addMapTiles(map, configuration);
const markers = new Map<string, L.Marker>();
const positions = new Map<string, Position>();
let selected: string | undefined;
let fitted = false;
let socket: WebSocket | undefined;
let retry: ReturnType<typeof setTimeout> | undefined;
let stopped = false;
const status = document.getElementById("connection")!;
const selection = document.getElementById("selection")!;

function fit() {
  if (!positions.size) return;
  map.fitBounds(
    L.latLngBounds(
      [...positions.values()].map((p) => L.latLng(p.latitude, p.longitude)),
    ),
    {
      paddingTopLeft: [50, 70],
      paddingBottomRight: [50, 90],
      maxZoom: 16,
    },
  );
}
document.getElementById("fit")!.addEventListener("click", fit);

function render() {
  for (const car of cars) {
    const position = positions.get(car.id);
    if (!position) continue;
    let marker = markers.get(car.id);
    if (!marker) {
      marker = L.marker([position.latitude, position.longitude], {
        icon: L.divIcon({
          className: "car",
          html: `<span>${cars.indexOf(car) + 1}</span>`,
          iconSize: [36, 44],
          iconAnchor: [18, 44],
        }),
        title: car.name,
        keyboard: true,
        autoPanOnFocus: false,
      }).addTo(map);
      marker.on("click", () => {
        selected = car.id;
        render();
      });
      markers.set(car.id, marker);
    }
    marker.setLatLng([position.latitude, position.longitude]);
    const element = marker.getElement()!;
    element.dataset.entityId = car.id;
    element.dataset.sequence = String(position.sequence);
    element.setAttribute("aria-label", `Inspect ${car.name}`);
    element.classList.toggle("selected", selected === car.id);
    if (selected === car.id) {
      selection.hidden = false;
      selection.textContent = `${car.name} · report ${position.sequence} · ${car.roads.join(" / ")}`;
    }
  }
  if (!fitted && positions.size === cars.length) {
    fitted = true;
    fit();
  }
}

function connect() {
  clearTimeout(retry);
  if (stopped || document.hidden) return;
  const previous = socket;
  socket = undefined;
  previous?.close();
  status.textContent = "Connecting…";
  const current = new WebSocket(`ws://${location.host}/views/live`);
  socket = current;
  current.onopen = () => {
    if (socket !== current) return;
    status.textContent = "Receiving positions";
    for (const car of cars)
      current.send(
        JSON.stringify({
          action: "subscribe",
          viewId: "driving",
          entityId: car.id,
        }),
      );
  };
  current.onmessage = (event) => {
    if (socket !== current) return;
    try {
      const message = JSON.parse(event.data);
      if (
        message.type !== "view-update" ||
        message.viewId !== "driving" ||
        !cars.some((car) => car.id === message.entityId)
      )
        return;
      const p = message.data.position;
      if (
        !p ||
        ![p.sequence, p.latitude, p.longitude, p.observedAt].every(
          Number.isFinite,
        ) ||
        Math.abs(p.latitude) > 90 ||
        Math.abs(p.longitude) > 180
      )
        return;
      positions.set(message.entityId, p);
      render();
    } catch {
      status.textContent = "Invalid position received";
    }
  };
  current.onclose = () => {
    if (socket !== current || stopped) return;
    status.textContent = "Disconnected · retrying";
    retry = setTimeout(connect, 1500);
  };
  current.onerror = () => current.close();
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) connect();
  else {
    clearTimeout(retry);
    socket?.close();
  }
});
window.addEventListener("pageshow", () => {
  if (!socket || socket.readyState > WebSocket.OPEN) connect();
});
window.addEventListener("pagehide", () => {
  clearTimeout(retry);
  socket?.close();
});
window.addEventListener("beforeunload", () => {
  stopped = true;
  clearTimeout(retry);
  socket?.close();
  tiles.close();
  map.remove();
});
const resize = new ResizeObserver(() => map.invalidateSize());
resize.observe(document.getElementById("map")!);
connect();
