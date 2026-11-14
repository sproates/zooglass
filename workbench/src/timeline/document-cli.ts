import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import { runDocument } from "./run-document.js";
const args = process.argv.slice(2);
if (args.length > 3 || args.some((arg) => arg.startsWith("--")))
  throw new Error("Invalid execution arguments");
const [
  scenario,
  output,
  jar = "../zooglass/simulation-host/target/zooglass-simulation.jar",
] = args;
if (!scenario || !output)
  throw new Error(
    "Usage: timeline:execute SCENARIO OUTPUT.json [PREPARED_JAR]",
  );
const result = await runDocument(resolve(scenario), { jar: resolve(jar) });
await writeFile(output, JSON.stringify(result) + "\n", { flag: "wx" });
if (result.outcome !== "passed") process.exitCode = 1;
