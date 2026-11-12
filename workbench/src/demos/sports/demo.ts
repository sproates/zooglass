import { startSportsBrowser } from "./browser.js";

export async function runSportsDemo(args: string[]) {
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
    const demo = await startSportsBrowser({
      signal: controller.signal,
      bindAddress: args[1]?.slice(7),
    });
    try {
      console.log(
        `Three synthetic matches. Open ${demo.origin} in any browser. Ctrl+C stops the demo.`,
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
