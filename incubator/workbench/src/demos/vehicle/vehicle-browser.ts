import { fleetAssets, type FleetMapConfiguration } from "./fleet-assets.js";
import { readFile } from "node:fs/promises";
import {
  startBrowserHost,
  type BrowserApplication,
} from "../../browser/browser-host.js";
import {
  startBrowserSession,
  type BrowserSessionOptions,
} from "../../browser/browser-session.js";

export type VehicleBrowserSessionOptions = Omit<
  BrowserSessionOptions,
  "application"
> & { fleet?: boolean; map?: FleetMapConfiguration };

/** Vehicle assets and identity belong to demo composition, not the transport host. */
export async function vehicleBrowserApplication(
  fleet = false,
  map?: FleetMapConfiguration,
): Promise<BrowserApplication> {
  const assets = new Map<string, readonly [string, Buffer]>([
    [
      "/",
      [
        "text/html; charset=utf-8",
        await readFile(
          new URL(
            `../../../../vehicle-tracker/${fleet ? "fleet" : "index"}.html`,
            import.meta.url,
          ),
        ),
      ],
    ],
    [
      "/bridge.js",
      [
        "text/javascript; charset=utf-8",
        await readFile(new URL("../../../browser/bridge.js", import.meta.url)),
      ],
    ],
    [
      "/vehicle-bootstrap.js",
      [
        "text/javascript; charset=utf-8",
        await readFile(
          new URL("../../../browser/vehicle-bootstrap.js", import.meta.url),
        ),
      ],
    ],
    [
      "/vehicle-client.js",
      [
        "text/javascript; charset=utf-8",
        await readFile(
          new URL(
            "../../../../vehicle-tracker/dist/vehicle-client.js",
            import.meta.url,
          ),
        ),
      ],
    ],
    [
      "/subscription-client.js",
      [
        "text/javascript; charset=utf-8",
        await readFile(
          new URL(
            "../../../../vehicle-tracker/dist/subscription-client.js",
            import.meta.url,
          ),
        ),
      ],
    ],
    [
      "/recovering-client.js",
      [
        "text/javascript; charset=utf-8",
        await readFile(
          new URL(
            "../../../../vehicle-tracker/dist/recovering-client.js",
            import.meta.url,
          ),
        ),
      ],
    ],
    [
      "/activity.js",
      [
        "text/javascript; charset=utf-8",
        await readFile(
          new URL(
            "../../../../vehicle-tracker/dist/activity.js",
            import.meta.url,
          ),
        ),
      ],
    ],
    [
      "/view.js",
      [
        "text/javascript; charset=utf-8",
        await readFile(
          new URL("../../../../vehicle-tracker/dist/view.js", import.meta.url),
        ),
      ],
    ],
    [
      "/vehicle.css",
      [
        "text/css; charset=utf-8",
        await readFile(
          new URL("../../../../vehicle-tracker/vehicle.css", import.meta.url),
        ),
      ],
    ],
  ] as const);
  if (fleet)
    for (const [path, asset] of await fleetAssets(map)) assets.set(path, asset);
  return {
    clientId: fleet ? "fleet-viewer" : "rider-app",
    assets,
    imageOrigins:
      fleet && map?.tileUrl.startsWith("https://")
        ? [new URL(map.tileUrl).origin]
        : [],
  };
}

export async function startVehicleBrowserSession(
  baseUrl: string,
  options: VehicleBrowserSessionOptions,
) {
  return startBrowserSession(baseUrl, {
    ...options,
    application: await vehicleBrowserApplication(options.fleet, options.map),
  });
}

export async function startVehicleBrowserHost(baseUrl: string) {
  return startBrowserHost(baseUrl, {
    application: await vehicleBrowserApplication(),
  });
}
