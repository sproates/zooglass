import { writeFile } from "node:fs/promises";
import { runDocument } from "../src/timeline/run-document.js";
const [input, output, jar, modeJson] = process.argv.slice(2);
const mode = JSON.parse(modeJson);
const result = await runDocument(input, { jar, ...mode });
await writeFile(output, JSON.stringify(result) + "\n", { flag: "wx" });
if (result.outcome !== "passed") process.exitCode = 1;
