import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import { replayDocument } from "./replay-document.js";
const [input, output, jar = "../zooglass/target/zooglass.jar"] =
  process.argv.slice(2);
if (!input || !output)
  throw new Error("Usage: timeline:replay RUN.json REPORT.json [PREPARED_JAR]");
if (resolve(input) === resolve(output))
  throw new Error("Replay output must not overwrite its input");
const report = await replayDocument(resolve(input), { jar: resolve(jar) });
await writeFile(output, JSON.stringify(report) + "\n", { flag: "wx" });
if (report.status !== "verified") process.exitCode = 1;
