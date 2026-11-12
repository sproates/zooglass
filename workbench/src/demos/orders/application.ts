import { readFile } from "node:fs/promises";
import type { BrowserApplication } from "../../browser/browser-host.js";

/** Exact routes keep the read-only demo separate from management/service APIs. */
export async function orderApplication(): Promise<BrowserApplication> {
  const assets = new Map<string, readonly [string, Buffer]>();
  const root = new URL("../../../../demos/order-tracker/", import.meta.url);
  for (const [path, file, mime] of [
    ["/", "pages/index.html", "text/html"],
    ["/styles.css", "pages/styles.css", "text/css"],
    ["/startup.js", "pages/startup.js", "text/javascript"],
    ...["app", "model", "view", "connection"].map((name) => [
      `/order-tracker/src/${name}.js`,
      `dist/order-tracker/src/${name}.js`,
      "text/javascript",
    ]),
    [
      "/vehicle-tracker/src/subscription-client.js",
      "dist/vehicle-tracker/src/subscription-client.js",
      "text/javascript",
    ],
  ]) {
    assets.set(path, [mime, await readFile(new URL(file, root))]);
  }
  return { clientId: "orders", assets };
}
