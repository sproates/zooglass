import { createInterface } from "node:readline";
import { startInteractiveOrders } from "./interactive.js";
import { startOrderBrowser } from "./browser.js";

export async function runOrderDemo(args: string[]) {
  const usage =
    "Usage: npm run demo -- order-tracker (--continuous | --interactive) [--bind=<private IPv4>]";
  if (args.length === 1 && args[0] === "--help") {
    console.log(usage);
    return;
  }
  if (
    !["--continuous", "--interactive"].includes(args[0]) ||
    args.length > 2 ||
    (args[1] && !args[1].startsWith("--bind="))
  ) {
    throw new Error(usage);
  }
  process.env.LOGGING_LEVEL_IO_ZOOGLASS ??= "WARN";
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    if (args[0] === "--interactive") {
      const demo = await startInteractiveOrders({
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
        console.log(`Order walkthrough. Open ${demo.origin}. ${help}`);
        await demo.done;
      } finally {
        input.close();
        await demo.close();
      }
      return;
    }
    const demo = await startOrderBrowser({
      bindAddress: args[1]?.slice(7),
      signal: controller.signal,
    });
    try {
      console.log(
        `Six simulated orders. Open ${demo.origin} in any browser. Ctrl+C stops the demo.`,
      );
      await demo.done;
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
