import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { loadScenario } from "./scenario.js";
import { createVehicleDemo } from "./vehicle-demo.js";
import { runAutomaticDemo } from "./automatic-demo.js";

async function main() {
  const args = process.argv.slice(2);

  if (
    args[0] !== "vehicle-tracker" ||
    args
      .slice(1)
      .some(
        (arg) =>
          !["--headless", "--basic", "--auto", "--recovery"].includes(arg),
      )
  )
    throw new Error(
      "Usage: npm run demo -- vehicle-tracker [--headless] [--basic | --recovery] [--auto]",
    );

  if (
    args.includes("--recovery") &&
    (args.includes("--basic") || args.includes("--auto"))
  )
    throw new Error("--recovery cannot be combined with --basic or --auto.");

  if (args.includes("--auto"))
    return runAutomaticDemo(args.filter((arg) => arg !== "--auto"));

  const scenario = await loadScenario(
    fileURLToPath(
      new URL(
        args.includes("--recovery")
          ? "../scenarios/vehicle-browser-recovery.json"
          : args.includes("--basic")
            ? "../scenarios/vehicle-browser-basic.json"
            : "../scenarios/vehicle-browser-journey.json",
        import.meta.url,
      ),
    ),
  );
  const demo = createVehicleDemo(scenario, {
    headless: args.includes("--headless"),
  });
  let stopped = false;
  let finish!: () => void;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });

  const stop = () => {
    stopped = true;
    finish();
    void demo.close().catch(() => {});
  };

  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  const input = createInterface({ input: process.stdin });

  input.on("line", (line) => {
    const action = line.trim().toLowerCase();

    if (action === "quit" || action === "q") return stop();
    if (
      !["step", "reset", "play", "pause", "disconnect", "reconnect"].includes(
        action,
      )
    ) {
      console.log(
        "Commands: step, play, pause, disconnect, reconnect, reset, quit.",
      );
      return;
    }

    void demo[
      action as "step" | "reset" | "play" | "pause" | "disconnect" | "reconnect"
    ]()
      .then(() => console.log(demo.state.detail))
      .catch((error: unknown) =>
        console.error(error instanceof Error ? error.message : error),
      );
  });

  try {
    console.log(
      "Use Step, Play, Pause and Reset in the browser, or type step, play, pause, disconnect, reconnect, reset or quit here. Reset remains available if the page closes.",
    );
    await demo.reset();
    console.log(demo.state.detail);
    await done;
  } catch (error) {
    if (!stopped) throw error;
  } finally {
    input.close();
    await demo.close();
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
