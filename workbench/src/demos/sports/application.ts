import { readFile } from "node:fs/promises";
import type { BrowserApplication } from "../../browser/browser-host.js";

/** Passive assets only; service management and source routes are not exposed. */
export async function sportsApplication(): Promise<BrowserApplication> {
  const root = new URL("../../../../demos/live-sports/", import.meta.url);
  const assets = new Map<string, readonly [string, Buffer]>();
  for (const [path, file, mime] of [
    ["/", "pages/index.html", "text/html"],
    ["/styles.css", "pages/styles.css", "text/css"],
    ["/startup.js", "pages/startup.js", "text/javascript"],
    ...["app", "model", "view", "connection"].map((name) => [
      `/live-sports/src/${name}.js`,
      `dist/live-sports/src/${name}.js`,
      "text/javascript",
    ]),
    [
      "/vehicle-tracker/src/subscription-client.js",
      "dist/vehicle-tracker/src/subscription-client.js",
      "text/javascript",
    ],
  ])
    assets.set(path, [mime, await readFile(new URL(file, root))]);
  return { clientId: "sports", assets };
}
