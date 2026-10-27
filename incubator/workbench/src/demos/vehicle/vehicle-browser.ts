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
> & { fleet?: boolean };

/** Vehicle assets and identity belong to demo composition, not the transport host. */
export async function vehicleBrowserApplication(
  fleet = false,
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
  if (fleet) {
    for (const module of ["client", "model", "view"]) {
      assets.set(`/fleet/${module}.js`, [
        "text/javascript; charset=utf-8",
        await readFile(
          new URL(
            `../../../../vehicle-tracker/dist/fleet/${module}.js`,
            import.meta.url,
          ),
        ),
      ]);
    }
    assets.set("/fleet-manifest.json", [
      "application/json; charset=utf-8",
      await readFile(
        new URL(
          "../../../../vehicle-tracker/fleet-manifest.json",
          import.meta.url,
        ),
      ),
    ]);
  }
  return { clientId: fleet ? "fleet-viewer" : "rider-app", assets };
}

export async function startVehicleBrowserSession(
  baseUrl: string,
  options: VehicleBrowserSessionOptions,
) {
  return startBrowserSession(baseUrl, {
    ...options,
    application: await vehicleBrowserApplication(options.fleet),
  });
}

export async function startVehicleBrowserHost(baseUrl: string) {
  return startBrowserHost(baseUrl, {
    application: await vehicleBrowserApplication(),
  });
}
