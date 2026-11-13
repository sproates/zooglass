import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import { replayDocument } from "./replay-document.js";
const args = process.argv.slice(2);
const requirePassed = args.includes("--require-passed");
const positional = args.filter((arg) => arg !== "--require-passed");
if (
  positional.some((arg) => arg.startsWith("--")) ||
  positional.length > 3 ||
  args.filter((arg) => arg === "--require-passed").length > 1
)
  throw new Error("Invalid replay arguments");
const [
  input,
  output,
  jar = "../zooglass/simulation-host/target/zooglass-simulation.jar",
] = positional;
if (!input || !output)
  throw new Error(
    "Usage: timeline:replay RUN.json REPORT.json [PREPARED_JAR] [--require-passed]",
  );
if (resolve(input) === resolve(output))
  throw new Error("Replay output must not overwrite its input");
const report = await replayDocument(resolve(input), { jar: resolve(jar) });
await writeFile(output, JSON.stringify(report) + "\n", { flag: "wx" });
if (report.status !== "verified") process.exitCode = 1;
else if (requirePassed && report.recordedOutcome !== "passed")
  process.exitCode = 2;
