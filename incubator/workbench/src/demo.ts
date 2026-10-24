import { fileURLToPath } from "node:url";
import { openScenarioSession } from "./scenario-session.js";
import { playScenario } from "./playback.js";
import { setTimeout as delay } from "node:timers/promises";
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
        const session = await openScenarioSession(scenario, service.baseUrl, {
          signal: browser.signal,
          createClientExecutor: (client) => {
            if (client.id !== browser.host.clientId)
              throw new Error("Unbound browser client.");
            return browser.host.executor;
          },
        });
        try {
          let previousTime = 0;
          for (const entry of playScenario(scenario)) {
            const wait = entry.simulationTime - previousTime;
            if (wait > 0)
              await delay(wait, undefined, { signal: browser.signal });
            await session.execute(entry);
            previousTime = entry.simulationTime;
          }
          console.log(
            "Basic fixture received by the browser. Inspect the vehicle views; Ctrl+C stops the demo.",
          );
          if (!browser.signal.aborted)
            await new Promise<void>((resolve) =>
              browser.signal.addEventListener("abort", () => resolve(), {
                once: true,
              }),
            );
          if (!controller.signal.aborted) throw browser.signal.reason;
        } finally {
          await session.close();
        }
      } finally {
        await browser.close();
      }
    } finally {
      await service.close();
    }
  } catch (error) {
    if (!controller.signal.aborted) throw error;
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
