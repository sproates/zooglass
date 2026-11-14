import { realpath, writeFile } from "node:fs/promises";
import { resolve, dirname, basename } from "node:path";
import { compareRuns, readComparisonInput } from "./compare.js";

const args = process.argv.slice(2);
if (args.length !== 3 || args.some((arg) => arg.startsWith("--")))
  throw new Error(
    "Usage: timeline:compare LEFT_RUN_OR_BUNDLE RIGHT_RUN_OR_BUNDLE NEW_REPORT.json",
  );
const [left, right, output] = args;
const destination = resolve(
  await realpath(dirname(resolve(output))),
  basename(output),
);
const inputs = await Promise.all(
  [left, right].map((path) => readComparisonInput(path, destination)),
);
const report = compareRuns(inputs[0], inputs[1]);
await writeFile(destination, JSON.stringify(report) + "\n", { flag: "wx" });
process.exitCode =
  report.status === "equal" ? 0 : report.status === "different" ? 2 : 1;
