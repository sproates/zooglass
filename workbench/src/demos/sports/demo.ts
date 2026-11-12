import { startSportsBrowser } from "./browser.js";

export async function runSportsDemo(
  args: string[],
  startBrowser: typeof startSportsBrowser = startSportsBrowser,
) {
  const usage =
    "Usage: npm run demo -- live-sports --continuous [--bind=<private IPv4>]";
  if (args.length === 1 && args[0] === "--help") {
    console.log(usage);
    return;
  }
  if (
    args[0] !== "--continuous" ||
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
