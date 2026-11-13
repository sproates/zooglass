import { createInterface } from "node:readline";
import { startInteractiveSports } from "./interactive.js";
import { startSportsBrowser } from "./browser.js";

export async function runSportsDemo(
  args: string[],
  startBrowser: typeof startSportsBrowser = startSportsBrowser,
) {
  const usage =
    "Usage: npm run demo -- live-sports (--continuous | --interactive) [--bind=<private IPv4>]";
  if (args.length === 1 && args[0] === "--help") {
    console.log(usage);
    return;
  }
  if (
    !["--continuous", "--interactive"].includes(args[0]) ||
    args.length > 2 ||
    (args[1] && !args[1].startsWith("--bind="))
  )
    throw new Error(usage);
  process.env.LOGGING_LEVEL_IO_ZOOGLASS ??= "WARN";
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    if (args[0] === "--interactive") {
      const demo = await startInteractiveSports({
        bindAddress: args[1]?.slice(7),
        signal: controller.signal,
      });
      const input = createInterface({ input: process.stdin });
      const help =
        "step / play / pause / reset · help / ? · quit / q. Step awaits checks; Pause finishes the current checkpoint. Reset starts a fresh store.";
      input.on("line", (line) => {
        const command = line.trim();
        if (["quit", "q"].includes(command)) {
          stop();
          return;
        }
        if (["", "help", "?"].includes(command)) {
          console.log(help);
          return;
        }
        if (!["step", "play", "pause", "reset"].includes(command)) {
          console.error("Unknown command. Type help.");
          return;
        }
        void demo
          .command(command as "step" | "play" | "pause" | "reset")
          .then(() => console.log(demo.state.detail))
          .catch((error) => console.error(error.message));
      });
      try {
        console.log(`Sports walkthrough. Open ${demo.origin}. ${help}`);
        await demo.done;
      } finally {
        input.close();
        await demo.close();
      }
      return;
    }
    const demo = await startBrowser({
      signal: controller.signal,
      bindAddress: args[1]?.slice(7),
    });
    try {
      console.log(
        `Three synthetic matches. Open ${demo.origin} in any browser. Ctrl+C stops the demo.`,
      );
      try {
        await demo.done;
      } catch (error) {
        if (!controller.signal.aborted) {
          console.error("Simulation stopped:", error);
          console.error(
            "The failed run remains available in the browser. Ctrl+C exits.",
          );
          await new Promise<void>((resolve) => {
            controller.signal.addEventListener("abort", () => resolve(), {
              once: true,
            });
          });
        }
      }
    } finally {
      await demo.close();
    }
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}
