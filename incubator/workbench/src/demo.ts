import { fileURLToPath } from "node:url";
import { loadScenario } from "./scenario.js";
import { startZooGlassSession } from "./zooglass-session.js";
import { startBrowserSession } from "./browser-session.js";

async function main() {
  const args = process.argv.slice(2);
  if (
    args[0] !== "vehicle-tracker" ||
    args.slice(1).some((arg) => arg !== "--headless")
  ) {
    throw new Error("Usage: npm run demo -- vehicle-tracker [--headless]");
  }
  const controller = new AbortController();
  const stop = () => controller.abort(new Error("Demo interrupted."));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const scenario = await loadScenario(
      fileURLToPath(
        new URL("../scenarios/vehicle-browser-basic.json", import.meta.url),
      ),
    );
    const service = await startZooGlassSession({
      views: scenario.views,
      signal: controller.signal,
    });
    try {
      const browser = await startBrowserSession(service.baseUrl, {
        signal: service.signal,
        headless: args.includes("--headless"),
      });
      try {
        console.log(`Browser host ready at ${browser.host.origin}`);
        console.log(
          "Vehicle display and scenario execution are pending. Press Ctrl+C to stop.",
        );
        if (!browser.signal.aborted)
          await new Promise<void>((resolve) =>
            browser.signal.addEventListener("abort", () => resolve(), {
              once: true,
            }),
          );
        if (!controller.signal.aborted) throw browser.signal.reason;
      } finally {
        await browser.close();
      }
    } finally {
      await service.close();
    }
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}
main().catch((error: unknown) => {
  console.error(
    `Demo could not run: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
