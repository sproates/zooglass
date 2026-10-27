import * as L from "/vendor/leaflet/leaflet-src.esm.js";
import type { FleetModel } from "./model.js";

/** Local map navigation; never changes subscriptions or scenario playback. */
export function createMapControls(map: L.Map, model: FleetModel) {
  const fit = document.getElementById("fit-fleet") as HTMLButtonElement;
  const follow = document.getElementById(
    "follow-selected",
  ) as HTMLButtonElement;
  const status = document.getElementById("map-navigation-status")!;
  let following = false;
  let lastTarget = "";

  function render() {
    const position = model.get("fleet-state", model.selected).position;
    fit.disabled = !model.vehicles.some(
      (vehicle) => model.get("fleet-state", vehicle.id).position,
    );
    follow.disabled = !position && !following;
    follow.setAttribute("aria-pressed", String(following));
    const name = model.vehicles.find(
      (vehicle) => vehicle.id === model.selected,
    )!.name;
    const message = following
      ? `Following ${name}${position ? " · last received position" : " · waiting for a position"}. Pan to stop following.`
      : "Free map navigation. Fit fleet shows all received positions.";
    if (status.textContent !== message) status.textContent = message;

    if (following && position) {
      const target = `${model.selected}:${position.latitude}:${position.longitude}`;
      if (target !== lastTarget) {
        lastTarget = target;
        map.panTo([position.latitude, position.longitude], { animate: false });
      }
    }
  }

  const stopFollowing = () => {
    following = false;
    lastTarget = "";
    render();
  };

  fit.addEventListener("click", () => {
    stopFollowing();
    const positions = model.vehicles.flatMap((vehicle) => {
      const p = model.get("fleet-state", vehicle.id).position;
      return p ? [L.latLng(p.latitude, p.longitude)] : [];
    });
    if (positions.length)
      map.fitBounds(L.latLngBounds(positions), {
        padding: [40, 40],
        maxZoom: 17,
        animate: false,
      });
  });
  follow.addEventListener("click", () => {
    following = !following;
    lastTarget = "";
    render();
  });
  map.on("dragstart boxzoomstart", stopFollowing);
  map.getContainer().addEventListener(
    "keydown",
    (event) => {
      if (
        event.target === map.getContainer() &&
        ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)
      )
        stopFollowing();
    },
    true,
  );
  map.getContainer().addEventListener(
    "touchstart",
    (event) => {
      if (event.touches.length > 1) stopFollowing();
    },
    { passive: true },
  );

  render();
  return { render };
}
