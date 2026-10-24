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
    args.slice(1).some((arg) => !["--headless", "--basic"].includes(arg))
  ) {
    throw new Error(
      "Usage: npm run demo -- vehicle-tracker [--headless] [--basic]",
    );
  }
  const controller = new AbortController();
  const stop = () => controller.abort(new Error("Demo interrupted."));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const scenario = await loadScenario(
      fileURLToPath(
        new URL(
          args.includes("--basic")
            ? "../scenarios/vehicle-browser-basic.json"
            : "../scenarios/vehicle-browser-journey.json",
          import.meta.url,
        ),
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
        keepOpenOnFailure: !args.includes("--headless"),
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
            `${args.includes("--basic") ? "Basic fixture" : "Journey"} received by the browser. Inspect the vehicle views; Ctrl+C stops the demo.`,
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
      } catch (error) {
        if (
          !args.includes("--headless") &&
          !controller.signal.aborted &&
          !browser.page.isClosed()
        ) {
          process.exitCode = 1;
          console.error(
            `Run failed; playback stopped. Inspect the browser, then close it or press Ctrl+C. ${error instanceof Error ? error.message : String(error)}`,
          );
          await Promise.race([
            browser.page.waitForEvent("close", { timeout: 0 }),
            new Promise<void>((resolve) =>
              controller.signal.addEventListener("abort", () => resolve(), {
                once: true,
              }),
            ),
          ]);
        }
        throw error;
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
