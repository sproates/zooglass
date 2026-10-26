/**
 * Print-only scenario CLI (`npm run simulate`): validate a fixture and print its
 * ordered trace without starting ZooGlass.
 * See ../docs/source-map.md for the module relationships.
 */
import { resolve } from "node:path";
import { formatTraceEntry, playScenario } from "./playback.js";
import { loadScenario } from "./scenario.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length > 1) {
    throw new Error("Usage: npm run simulate -- [scenario.json]");
  }

  const scenarioPath = resolve(args[0] ?? "scenarios/live-match.json");
  const scenario = await loadScenario(scenarioPath);

  console.log(scenario.name);
  console.log(`Scenario file: ${scenarioPath}`);
  console.log("Simulation time | Source event or client state");

  for (const entry of playScenario(scenario)) {
    console.log(formatTraceEntry(entry));
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Scenario could not be played: ${message}`);
  process.exitCode = 1;
});
