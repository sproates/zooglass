import { mkdir, open, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runDriver } from "./driver.js";
import { baseline } from "./workload.js";

/** A single diagnostic execution, not the frozen capacity campaign. */
async function main() {
  const args = process.argv.slice(2);
  if (
    args.length !== 3 ||
    !["memory", "sqlite"].includes(args[0]) ||
    !/^(10|30|100|300|1000)$/.test(args[1])
  )
    throw new Error(
      "Usage: benchmark:run -- memory|sqlite 10|30|100|300|1000 NEW_DIRECTORY",
    );
  const directory = resolve(args[2]);
  await mkdir(directory);
  const stop = new AbortController();
  const cancel = () => stop.abort(new Error("Benchmark interrupted"));
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const result = await runDriver({
      workload: { ...baseline, storage: args[0] as "memory" | "sqlite" },
      rate: Number(args[1]),
      warmupMs: 30000,
      measurementMs: 120000,
      drainMs: 10000,
      signal: stop.signal,
    });
    const file = await open(resolve(directory, "observations.jsonl"), "wx");
    try {
      for (const chunk of result.observations) await file.writeFile(chunk);
    } finally {
      await file.close();
    }
    await writeFile(
      resolve(directory, "run.json"),
      JSON.stringify(result.report, null, 2) + "\n",
      { flag: "wx" },
    );
    console.log(
      `Execution ${result.report.status}: ${directory}. Capacity assessment not run.`,
    );
    process.exitCode = result.report.status === "completed" ? 0 : 2;
  } catch (cause) {
    await writeFile(
      resolve(directory, "failure.json"),
      JSON.stringify({ error: String(cause) }) + "\n",
      { flag: "wx" },
    );
    throw cause;
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}
main().catch((cause) => {
  console.error(String(cause));
  process.exitCode = 1;
});
