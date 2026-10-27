import * as L from "/vendor/leaflet/leaflet-src.esm.js";

export interface MapConfiguration {
  tileUrl: string;
  attribution: string;
  attributionUrl?: string;
}

/** Tile availability is presentation state, independent of ZooGlass connectivity. */
export function addMapTiles(map: L.Map, configuration: MapConfiguration) {
  const lifetime = new AbortController();
  const credit = document.createElement(
    configuration.attributionUrl ? "a" : "span",
  );
  credit.textContent = configuration.attribution;
  if (credit instanceof HTMLAnchorElement) {
    credit.href = configuration.attributionUrl!;
    credit.rel = "noopener noreferrer";
  }
  const library = document.createElement("a");
  library.href = "https://leafletjs.com/";
  library.textContent = "Leaflet";
  document
    .getElementById("map-attribution")!
    .replaceChildren(library, document.createTextNode(" | "), credit);
  const tiles = L.tileLayer(configuration.tileUrl, {
    maxZoom: 19,
    referrerPolicy: "strict-origin-when-cross-origin",
    updateWhenIdle: true,
    keepBuffer: 0,
  });
  const failed = new Set<HTMLElement>();
  const deadlines = new Map<HTMLElement, ReturnType<typeof setTimeout>>();
  const clearDeadline = (tile: HTMLElement) => {
    clearTimeout(deadlines.get(tile));
    deadlines.delete(tile);
  };
  const status = document.getElementById("map-background-status")!;
  const retry = document.getElementById("retry-map") as HTMLButtonElement;

  function render() {
    const state = failed.size
      ? "unavailable"
      : tiles.isLoading()
        ? "loading"
        : "available";
    if (status.dataset.state === state) return;
    status.dataset.state = state;
    status.textContent =
      state === "unavailable"
        ? "Map background unavailable. Some tiles failed or took too long; vehicle coordinates, history and controls still work."
        : state === "loading"
          ? "Loading map background…"
          : "Map background loaded.";
    retry.disabled = state !== "unavailable";
  }

  tiles.on("tileloadstart", (event: L.TileEvent) => {
    clearDeadline(event.tile);
    deadlines.set(
      event.tile,
      setTimeout(() => {
        deadlines.delete(event.tile);
        failed.add(event.tile);
        render();
      }, 10_000),
    );
  });
  tiles.on("tileerror", (event: L.TileErrorEvent) => {
    clearDeadline(event.tile);
    failed.add(event.tile);
    render();
  });
  const tileFinished = (event: L.TileEvent) => {
    clearDeadline(event.tile);
    failed.delete(event.tile);
    render();
  };
  tiles.on("tileunload", tileFinished);
  tiles.on("tileload", tileFinished);
  tiles.on("loading load", render);
  retry.addEventListener(
    "click",
    () => {
      failed.clear();
      tiles.redraw();
      render();
    },
    { signal: lifetime.signal },
  );
  tiles.addTo(map);
  render();
  return {
    close() {
      lifetime.abort();
      tiles.off();
      for (const timer of deadlines.values()) clearTimeout(timer);
      deadlines.clear();
    },
  };
}
