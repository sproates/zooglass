import { inspectAdmission } from "./admission.js";
import { readFile } from "node:fs/promises";
import { parseScenario } from "../scenario/scenario.js";
import { assessLegacyScenario } from "./compatibility.js";
import { parseTimelineDocument } from "./contract.js";
import { canonicalJson } from "./json.js";
import { validateTrace } from "./trace-contract.js";

const [mode, ...paths] = process.argv.slice(2);
if (
  !["scenario", "trace", "legacy", "admission"].includes(mode) ||
  paths.length === 0
)
  throw new Error(
    "Usage: timeline:inspect scenario|trace|legacy FILE... OR admission SCENARIO JAR (inspection only; never builds Java)",
  );
if (mode === "admission") {
  if (paths.length !== 2)
    throw new Error("Usage: timeline:inspect admission SCENARIO JAR");
  console.log(JSON.stringify(await inspectAdmission(paths[0], paths[1])));
} else
  for (const path of paths) {
    const raw = await readFile(path, "utf8");
    if (mode === "legacy") {
      canonicalJson(raw); // Reject duplicate keys before the legacy parser discards them.
      console.log(
        JSON.stringify({
          path,
          ...assessLegacyScenario(parseScenario(JSON.parse(raw))),
        }),
      );
    } else if (mode === "scenario") {
      const parsed = parseTimelineDocument(raw);
      console.log(
        JSON.stringify({
          path,
          syntax: "valid",
          execution: "unsupported",
          requiredCapabilities: parsed.requiredCapabilities,
        }),
      );
    } else {
      validateTrace(raw);
      console.log(
        JSON.stringify({ path, structure: "valid", executionVerified: false }),
      );
    }
  }
