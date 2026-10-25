import { readFile } from "node:fs/promises";
import { startBrowserHost, type BrowserApplication } from "./browser-host.js";
import { startBrowserSession } from "./browser-session.js";

/** Vehicle assets and identity belong to demo composition, not the transport host. */
export async function vehicleBrowserApplication(): Promise<BrowserApplication> {
  const assets = new Map<string, readonly [string, Buffer]>([
    [
      "/",
      [
        "text/html; charset=utf-8",
        await readFile(
          new URL("../../vehicle-tracker/index.html", import.meta.url),
        ),
      ],
    ],
    [
      "/bridge.js",
      [
        "text/javascript; charset=utf-8",
        await readFile(new URL("../browser/bridge.js", import.meta.url)),
      ],
    ],
    [
      "/vehicle-bootstrap.js",
      [
        "text/javascript; charset=utf-8",
        await readFile(
          new URL("../browser/vehicle-bootstrap.js", import.meta.url),
        ),
      ],
    ],
    [
      "/vehicle-client.js",
      [
        "text/javascript; charset=utf-8",
        await readFile(
          new URL(
            "../../vehicle-tracker/dist/vehicle-client.js",
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
            "../../vehicle-tracker/dist/subscription-client.js",
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
          new URL("../../vehicle-tracker/dist/view.js", import.meta.url),
        ),
      ],
    ],
    [
      "/vehicle.css",
      [
        "text/css; charset=utf-8",
        await readFile(
          new URL("../../vehicle-tracker/vehicle.css", import.meta.url),
        ),
      ],
    ],
  ] as const);
  return { clientId: "rider-app", assets };
}

export async function startVehicleBrowserSession(
  baseUrl: string,
  options: Omit<Parameters<typeof startBrowserSession>[1], "application">,
) {
  return startBrowserSession(baseUrl, {
    ...options,
    application: await vehicleBrowserApplication(),
  });
}

export async function startVehicleBrowserHost(baseUrl: string) {
  return startBrowserHost(baseUrl, {
    application: await vehicleBrowserApplication(),
  });
}
