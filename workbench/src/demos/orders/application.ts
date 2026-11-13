import { readFile } from "node:fs/promises";
import type { BrowserApplication } from "../../browser/browser-host.js";

/** Exact routes keep the read-only demo separate from management/service APIs. */
export async function orderApplication(
  interactive = false,
): Promise<BrowserApplication> {
  const assets = new Map<string, readonly [string, Buffer]>();
  const root = new URL("../../../../demos/order-tracker/", import.meta.url);
  for (const [path, file, mime] of [
    ["/", "pages/index.html", "text/html"],
    ["/styles.css", "pages/styles.css", "text/css"],
    ["/startup.js", "pages/startup.js", "text/javascript"],
    ...["app", "model", "view", "connection", "controls", "protected"].map(
      (name) => [
        `/order-tracker/src/${name}.js`,
        `dist/order-tracker/src/${name}.js`,
        "text/javascript",
      ],
    ),
    [
      "/vehicle-tracker/src/playback-controls.js",
      "dist/vehicle-tracker/src/playback-controls.js",
      "text/javascript",
    ],
    [
      "/vehicle-tracker/src/subscription-client.js",
      "dist/vehicle-tracker/src/subscription-client.js",
      "text/javascript",
    ],
  ]) {
    assets.set(path, [mime, await readFile(new URL(file, root))]);
  }
  if (interactive) {
    const page = assets.get("/")!;
    assets.set("/", [
      page[0],
      Buffer.from(
        page[1]
          .toString()
          .replace("Continuous demo", "Interactive demo")
          .replace("<body>", '<body data-interactive="true">'),
      ),
    ]);
  }
  return { clientId: "orders", assets };
}
