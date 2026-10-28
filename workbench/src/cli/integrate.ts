/**
 * Connected scenario CLI (`npm run integrate`): start ZooGlass, execute fixtures
 * through Node clients, verify their expected views and close owned resources.
 * See ../../docs/source-map.md for the module relationships.
 */
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { formatTraceEntry, playScenario } from "../scenario/playback.js";
import { loadScenario } from "../scenario/scenario.js";
import { namespaceScenario } from "../scenario/namespace-scenario.js";
import { startZooGlassSession } from "../service/zooglass-session.js";
import {
  openScenarioSession,
  requireDataFaultSupport,
} from "../execution/scenario-session.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const fastPlayback = args.includes("--fast");
  const scenarioPaths = args.filter((argument) => argument !== "--fast");

  if (scenarioPaths.some((path) => path.startsWith("--"))) {
    throw new Error("Usage: npm run integrate -- [--fast] [scenario.json ...]");
  }

  if (scenarioPaths.length === 0) {
    scenarioPaths.push("scenarios/live-match.json");
  }

  const scenarios = await Promise.all(
    scenarioPaths.map(async (path, index) =>
      namespaceScenario(await loadScenario(resolve(path)), index),
    ),
  );
  for (const scenario of scenarios) requireDataFaultSupport(scenario);
  const controller = new AbortController();

  const stop = () => controller.abort(new Error("Workbench interrupted."));

  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  try {
    const service = await startZooGlassSession({
      views: scenarios.flatMap((scenario) => scenario.views),
      signal: controller.signal,
    });

    try {
      console.log(`ZooGlass is ready at ${service.baseUrl}`);
      for (const scenario of scenarios) {
        console.log(`Scenario: ${scenario.name}`);

        const session = await openScenarioSession(scenario, service.baseUrl, {
          signal: service.signal,
        });

        try {
          const startedAt = performance.now();
          for (const entry of playScenario(scenario)) {
            if (!fastPlayback) {
              const waitTime =
                entry.simulationTime - (performance.now() - startedAt);

              if (waitTime > 0)
                await delay(waitTime, undefined, { signal: service.signal });
            }

            console.log(formatTraceEntry(entry));
            await session.execute(entry);
          }
        } finally {
          await session.close();
        }

        console.log(
          `Finished scenario. Events were sent from ${scenario.sources.length} source connection(s).`,
        );
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
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Connected scenario could not be played: ${message}`);
  process.exitCode = 1;
});
