import { readFile } from "node:fs/promises";
import { fleetAssets, type FleetMapConfiguration } from "../fleet-assets.js";
import type { BrowserApplication } from "../../../browser/browser-host.js";
import type { Car } from "./journeys.js";

export async function drivingApplication(
  cars: Car[],
  map?: FleetMapConfiguration,
): Promise<BrowserApplication> {
  const assets = await fleetAssets(map);
  for (const [url, file, mime] of [
    ["/", "driving.html", "text/html"],
    ["/driving.css", "driving.css", "text/css"],
    ["/driving/app.js", "dist/driving/app.js", "text/javascript"],
  ]) {
    assets.set(url, [
      mime,
      await readFile(
        new URL(`../../../../../vehicle-tracker/${file}`, import.meta.url),
      ),
    ]);
  }
  assets.set("/cars.json", [
    "application/json",
    Buffer.from(
      JSON.stringify(
        cars.map((car) => ({
          id: car.id,
          name: car.name,
          roads: car.route.roads,
        })),
      ),
    ),
  ]);
  return {
    clientId: "driving",
    assets,
    imageOrigins: map?.tileUrl.startsWith("https:")
      ? [new URL(map.tileUrl).origin]
      : [],
  };
}
