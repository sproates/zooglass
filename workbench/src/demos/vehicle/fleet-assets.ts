import { readFile } from "node:fs/promises";

export interface FleetMapConfiguration {
  tileUrl: string;
  attribution: string;
  attributionUrl?: string;
}

// Programmatic runs and tests are local-only unless a caller explicitly opts in.
const localTiles: FleetMapConfiguration = {
  tileUrl: "/map-tile.svg",
  attribution: "Local synthetic test background",
};

export function interactiveMapConfiguration(
  env: NodeJS.ProcessEnv = process.env,
): FleetMapConfiguration {
  const tileUrl = env.ZOOGLASS_MAP_TILE_URL;
  if (!tileUrl)
    return {
      tileUrl: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
      attribution: "© OpenStreetMap contributors",
      attributionUrl: "https://www.openstreetmap.org/copyright",
    };

  if (tileUrl === "local") return localTiles;
  if (
    !tileUrl.startsWith("https://") ||
    !["{z}", "{x}", "{y}"].every((part) => tileUrl.includes(part)) ||
    !env.ZOOGLASS_MAP_ATTRIBUTION?.trim()
  )
    throw new Error(
      "Custom map tiles need an HTTPS {z}/{x}/{y} URL and ZOOGLASS_MAP_ATTRIBUTION.",
    );
  const url = new URL(tileUrl);
  if (url.username || url.password)
    throw new Error("Map tile URLs must not contain credentials.");
  const attributionUrl = env.ZOOGLASS_MAP_ATTRIBUTION_URL;
  if (attributionUrl && new URL(attributionUrl).protocol !== "https:")
    throw new Error("Map attribution links must use HTTPS.");
  return { tileUrl, attribution: env.ZOOGLASS_MAP_ATTRIBUTION, attributionUrl };
}

/** Fleet-only assets, including the installed, locally served Leaflet distribution. */
export async function fleetAssets(configuration = localTiles) {
  const assets = new Map<string, readonly [string, Buffer]>();
  for (const module of [
    "client",
    "model",
    "view",
    "map",
    "map-controls",
    "map-tiles",
  ]) {
    assets.set(`/fleet/${module}.js`, [
      "text/javascript; charset=utf-8",
      await readFile(
        new URL(
          `../../../../demos/vehicle-tracker/dist/fleet/${module}.js`,
          import.meta.url,
        ),
      ),
    ]);
  }
  assets.set("/fleet-manifest.json", [
    "application/json; charset=utf-8",
    await readFile(
      new URL(
        "../../../../demos/vehicle-tracker/pages/interactive/fleet-manifest.json",
        import.meta.url,
      ),
    ),
  ]);
  assets.set("/map-config.json", [
    "application/json; charset=utf-8",
    Buffer.from(JSON.stringify(configuration)),
  ]);
  assets.set("/map-tile.svg", [
    "image/svg+xml",
    Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#e6ebe1"/><path d="M0 128H256M128 0V256" stroke="#d7dfd3"/><text x="12" y="24" fill="#53675b" font-size="12">Local test tile · not geography</text></svg>',
    ),
  ]);
  for (const [file, mime] of [
    ["leaflet-src.esm.js", "text/javascript"],
    ["leaflet.css", "text/css"],
  ]) {
    assets.set(`/vendor/leaflet/${file}`, [
      `${mime}; charset=utf-8`,
      await readFile(
        new URL(`../../../node_modules/leaflet/dist/${file}`, import.meta.url),
      ),
    ]);
  }
  assets.set("/vendor/leaflet/LICENSE", [
    "text/plain; charset=utf-8",
    await readFile(
      new URL("../../../node_modules/leaflet/LICENSE", import.meta.url),
    ),
  ]);
  return assets;
}
