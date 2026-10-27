/**
 * Vehicle demo CLI (`npm run demo`): select interactive browser/terminal controls
 * or automatic playback, and own command-line shutdown.
 * See ../../../docs/source-map.md for the module relationships.
 */
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { loadScenario } from "../../scenario/scenario.js";
import { createVehicleDemo } from "./vehicle-demo.js";
import { runAutomaticDemo } from "./automatic-demo.js";

const terminalHelp = `Terminal commands (type a command and press Enter):
  step         Advance one scripted checkpoint and wait for its checks.
  play         Continue the scenario from the current checkpoint.
  pause        Stop future steps; let the current checkpoint finish.
  disconnect   Close the viewer's data socket; keep the source running.
  reconnect    Open the viewer socket and restore the scenario subscriptions.
  interrupt    Break the data route and refuse connections until restored.
  restore      Reopen the route; the armed client retries automatically.
  reset        Close the old browser/service and start a fresh session.
  help, ?      Show this help again. Pressing Enter also shows help.
  quit, q      Stop the demo and close its owned resources (or Ctrl+C).

Use Step/Play for the scripted checks. Manual disconnect/reconnect and
interrupt/restore mark the run Exploratory and skip affected client checks
until Reset. Pause and wait for an idle run before using manual controls.
An armed recovery has a 30-second deadline, even while paused; Reset after expiry.
Reset remains available here if the browser page closes.`;

async function main() {
  const args = process.argv.slice(2);

  if (
    (args.length === 1 && args[0] === "--help") ||
    (args.length === 2 && args[0] === "vehicle-tracker" && args[1] === "--help")
  ) {
    console.log(
      "Usage: npm run demo -- vehicle-tracker [--headless] [--basic | --recovery | --fault | --fleet] [--auto]",
    );
    console.log(
      "Interactive mode is the default; --auto has no terminal commands.\n",
    );
    console.log(terminalHelp);
    return;
  }

  if (
    args[0] !== "vehicle-tracker" ||
    args
      .slice(1)
      .some(
        (arg) =>
          ![
            "--headless",
            "--basic",
            "--auto",
            "--recovery",
            "--fault",
            "--fleet",
          ].includes(arg),
      )
  )
    throw new Error(
      "Usage: npm run demo -- vehicle-tracker [--headless] [--basic | --recovery | --fault | --fleet] [--auto]",
    );

  if (
    (args.includes("--recovery") || args.includes("--fault")) &&
    (args.includes("--basic") ||
      args.includes("--auto") ||
      (args.includes("--recovery") && args.includes("--fault")))
  )
    throw new Error(
      "--recovery and --fault cannot be combined with each other, --basic or --auto.",
    );

  if (
    args.includes("--fleet") &&
    ["--basic", "--recovery", "--fault", "--auto"].some((arg) =>
      args.includes(arg),
    )
  )
    throw new Error(
      "--fleet cannot be combined with --basic, --recovery, --fault or --auto.",
    );

  if (args.includes("--auto"))
    return runAutomaticDemo(args.filter((arg) => arg !== "--auto"));

  const scenario = await loadScenario(
    fileURLToPath(
      new URL(
        args.includes("--fleet")
          ? "../../../scenarios/vehicle-fleet-contracts.json"
          : args.includes("--fault")
            ? "../../../scenarios/browser/vehicle-connection-loss.json"
            : args.includes("--recovery")
              ? "../../../scenarios/vehicle-browser-recovery.json"
              : args.includes("--basic")
                ? "../../../scenarios/vehicle-browser-basic.json"
                : "../../../scenarios/vehicle-browser-journey.json",
        import.meta.url,
      ),
    ),
  );
  const demo = createVehicleDemo(scenario, {
    headless: args.includes("--headless"),
    fleet: args.includes("--fleet"),
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

    if (action === "help" || action === "?" || action === "") {
      console.log(terminalHelp);
      return;
    }

    if (
      ![
        "step",
        "reset",
        "play",
        "pause",
        "disconnect",
        "reconnect",
        "interrupt",
        "restore",
      ].includes(action)
    ) {
      console.log(
        `Unknown command: ${action}. Type help for available commands.`,
      );
      return;
    }

    void demo[
      action as
        | "step"
        | "reset"
        | "play"
        | "pause"
        | "disconnect"
        | "reconnect"
        | "interrupt"
        | "restore"
    ]()
      .then(() => console.log(demo.state.detail))
      .catch((error: unknown) =>
        console.error(error instanceof Error ? error.message : error),
      );
  });

  try {
    console.log(terminalHelp);
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
