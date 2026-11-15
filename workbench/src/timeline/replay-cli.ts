import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import { replayDocument } from "./replay-document.js";
import { replayArguments, replayExitCode } from "./replay-policy.js";
const { positional, verificationOnly } = replayArguments(process.argv.slice(2));
if (positional.length > 3) throw new Error("Invalid replay arguments");
const [
  input,
  output,
  jar = "../zooglass/simulation-host/target/zooglass-simulation.jar",
] = positional;
if (!input || !output)
  throw new Error(
    "Usage: timeline:replay RUN.json REPORT.json [PREPARED_JAR] [--verification-only]",
  );
if (resolve(input) === resolve(output))
  throw new Error("Replay output must not overwrite its input");
const report = await replayDocument(resolve(input), { jar: resolve(jar) });
await writeFile(output, JSON.stringify(report) + "\n", { flag: "wx" });
process.exitCode = replayExitCode(report, verificationOnly);
