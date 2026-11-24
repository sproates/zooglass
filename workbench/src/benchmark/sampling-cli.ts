import { resolve } from "node:path";
import { runSamplingDiagnostic } from "./sampling-diagnostic.js";

const stop = new AbortController();
const cancel = () => stop.abort(new Error("Sampling diagnostic interrupted"));
process.on("SIGINT", cancel);
process.on("SIGTERM", cancel);

try {
  const [target, flag, conditions, mode, ...extra] = process.argv.slice(2);
  if (
    !target ||
    flag !== "--conditions" ||
    !conditions?.trim() ||
    (mode !== undefined && mode !== "--smoke") ||
    extra.length
  )
    throw new Error(
      'Usage: benchmark:sampling DIRECTORY --conditions "observed host conditions" [--smoke]',
    );
  await runSamplingDiagnostic(
    resolve(target),
    conditions,
    mode === "--smoke",
    stop.signal,
  );
  console.log(
    "Client-only sampling diagnostic saved; no service capacity claim.",
  );
} catch (cause) {
  console.error(String(cause));
  process.exitCode = 1;
} finally {
  process.off("SIGINT", cancel);
  process.off("SIGTERM", cancel);
}
