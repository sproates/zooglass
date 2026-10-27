import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { loadScenario } from "../../scenario/scenario.js";
import type { BrowserControlAction } from "../../browser/browser-host.js";
import { interactiveMapConfiguration } from "./fleet-assets.js";
import { createExternalVehicleDemo } from "./external-vehicle-demo.js";

const help = `External fleet demo (synthetic data on a trusted local network):
  step / play / pause / reset   Control the shared scenario. Reset keeps pages open.
  pair <name>                  Print a single-use observer link, valid for five minutes.
  viewers                      List viewer IDs and the designated controller.
  control <viewer-id>           Pause playback and transfer control to that viewer.
  revoke <viewer-id>            Disconnect a viewer and invalidate its credentials.
  disconnect <viewer-id>        Close only that viewer's data connection.
  reconnect <viewer-id>         Resubscribe that viewer for current snapshots.
  interrupt <viewer-id>         Block that viewer's data route; recovery deadline is 30s.
  restore <viewer-id>           Restore the route and wait for fresh recovery snapshots.
  help / ?                     Show commands. Blank input also shows help.
  quit / q                     Close viewers, host and service.

Each phone/browser runs the actual app. Open a separate pairing link per device.
Refresh resumes a viewer in the same browser tab. No internet hosting or TLS is provided.
External runs check sources and HTTP views; they are not scripted browser verification.`;

export async function runExternalVehicleDemo(args: string[]) {
  const bindings = args.filter((arg) => arg.startsWith("--bind="));
  if (
    args[0] !== "vehicle-tracker" ||
    !args.includes("--fleet") ||
    bindings.length !== 1 ||
    args.slice(1).some((arg) => arg !== "--fleet" && !arg.startsWith("--bind="))
  )
    throw new Error(
      "Usage: npm run demo -- vehicle-tracker --fleet --bind=<local IPv4 address>",
    );
  const scenario = await loadScenario(
    fileURLToPath(
      new URL(
        "../../../scenarios/vehicle-fleet-contracts.json",
        import.meta.url,
      ),
    ),
  );
  const demo = await createExternalVehicleDemo(scenario, {
    bindAddress: bindings[0].slice("--bind=".length),
    map: interactiveMapConfiguration(),
  });
  let finish!: () => void;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let stopped = false;
  const stop = () => {
    stopped = true;
    finish();
    void demo.close().catch(() => {});
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const input = createInterface({ input: process.stdin });
  input.on("line", (line) => {
    const [verb, ...words] = line.trim().split(/\s+/);
    const target = words.join(" ");
    if (["quit", "q"].includes(verb)) {
      stop();
      return;
    }
    if (["", "help", "?"].includes(verb)) {
      console.log(help);
      return;
    }
    void (async () => {
      if (verb === "pair") {
        console.log(demo.host.pair(target).url);
        return;
      }
      if (verb === "viewers") {
        console.table(demo.host.list());
        return;
      }
      if (verb === "control") {
        demo.host.transfer(target);
        return;
      }
      if (verb === "revoke") {
        demo.host.revoke(target);
        return;
      }
      if (
        ![
          "step",
          "play",
          "pause",
          "reset",
          "disconnect",
          "reconnect",
          "interrupt",
          "restore",
        ].includes(verb)
      )
        throw new Error("Unknown command. Type help for available commands.");
      await demo.command(verb as BrowserControlAction, target || undefined);
      console.log(demo.state.detail);
    })().catch((error: unknown) =>
      console.error(error instanceof Error ? error.message : error),
    );
  });
  try {
    console.log(help);
    await demo.reset();
    console.log(
      `Controller pairing link: ${demo.host.pair("Controller", true).url}`,
    );
    console.log(
      "Use pair <name> for another device; viewers lists IDs for handover and faults.",
    );
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
