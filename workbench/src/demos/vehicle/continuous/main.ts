import { startSimulation } from "./simulation.js";
import { interactiveMapConfiguration } from "../fleet-assets.js";

export async function runContinuousDemo(args: string[]) {
  if (
    args.length > 1 ||
    (args.length === 1 && !args[0].startsWith("--bind="))
  ) {
    throw new Error(
      "Usage: npm run demo -- vehicle-tracker --continuous [--bind=<private IPv4>]",
    );
  }
  // Keep the continuous CLI readable; callers can opt into per-event service logs.
  process.env.LOGGING_LEVEL_IO_ZOOGLASS ??= "WARN";
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    const simulation = await startSimulation({
      bindAddress: args[0]?.slice(7) ?? "127.0.0.1",
      map: interactiveMapConfiguration(),
      signal: controller.signal,
    });
    try {
      console.log(
        `Six cars are driving. Open ${simulation.origin} in any browser. Ctrl+C stops the simulation.`,
      );
      await simulation.done;
    } finally {
      await simulation.close();
    }
  } catch (error) {
    if (!controller.signal.aborted) {
      throw error;
    }
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}
