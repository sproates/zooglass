import { runProfilePair } from "./runner.js";

const stop = new AbortController();
const cancel = () => stop.abort(new Error("SQLite profile interrupted"));
process.on("SIGINT", cancel);
process.on("SIGTERM", cancel);
try {
  const [directory, conditions, mode, ...extra] = process.argv.slice(2);
  if (
    !directory ||
    !conditions?.trim() ||
    extra.length ||
    (mode !== undefined && mode !== "--smoke")
  )
    throw new Error("Invalid profile worker arguments");
  await runProfilePair(
    directory,
    conditions,
    mode === "--smoke",
    Number(process.env.ZOOGLASS_CAMPAIGN_LOCK_FD),
    stop.signal,
  );
  console.log(
    "SQLite profile pair retained; diagnostic only, no capacity qualification.",
  );
} catch (cause) {
  console.error(String(cause));
  process.exitCode = 1;
} finally {
  process.off("SIGINT", cancel);
  process.off("SIGTERM", cancel);
}
