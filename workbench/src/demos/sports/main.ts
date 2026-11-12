import { parseArgs } from "node:util";
import { startSportsSimulation } from "./simulation.js";

// Source-only entry point: useful before attaching a browser to the accepted prototype.
const { values } = parseArgs({
  options: {
    cycles: { type: "string" },
    "tick-ms": { type: "string" },
  },
});
const lifetime = new AbortController();
const stop = () => lifetime.abort();
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
let simulation: Awaited<ReturnType<typeof startSportsSimulation>> | undefined;
try {
  simulation = await startSportsSimulation({
    ...(values.cycles === undefined ? {} : { cycles: Number(values.cycles) }),
    ...(values["tick-ms"] === undefined
      ? {}
      : { tickMs: Number(values["tick-ms"]) }),
    signal: lifetime.signal,
    onStep(step) {
      console.log(`Cycle ${step.cycle}: ${step.entityId} — ${step.name}`);
    },
  });
  console.log(`Sports views: ${simulation.baseUrl}/views/match-market/match-1`);
  console.log("Press Ctrl+C to stop the sources and service.");
  await simulation.done;
} catch (error) {
  if (!lifetime.signal.aborted) {
    console.error(error);
    process.exitCode = 1;
  }
} finally {
  await simulation?.close();
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
}
