import { startSimulation } from "./simulation.js";
import { interactiveMapConfiguration } from "../fleet-assets.js";

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && !args[0].startsWith("--bind=")))
  throw new Error("Usage: npm run demo:drive -- [--bind=<private IPv4>]");
// Keep the continuous CLI readable; callers can opt into per-event service logs.
process.env.LOGGING_LEVEL_IO_ZOOGLASS_EVENTLOGGINGWEBSOCKETHANDLER ??= "WARN";
const simulation = await startSimulation({
  bindAddress: args[0]?.slice(7) ?? "127.0.0.1",
  map: interactiveMapConfiguration(),
});
console.log(
  `Six cars are driving. Open ${simulation.origin} in any browser. Ctrl+C stops the simulation.`,
);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await simulation.close();
}
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
void simulation.done.catch(async (error) => {
  if (!stopping) {
    console.error(error);
    process.exitCode = 1;
    await stop();
  }
});
