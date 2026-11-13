import { readFile } from "node:fs/promises";
import { parseScenario } from "../scenario/scenario.js";
import { assessLegacyScenario } from "./compatibility.js";
import { parseTimelineDocument } from "./contract.js";
import { canonicalJson } from "./json.js";
import { validateTrace } from "./trace-contract.js";

const [mode, ...paths] = process.argv.slice(2);
if (!["scenario", "trace", "legacy"].includes(mode) || paths.length === 0)
  throw new Error(
    "Usage: timeline:inspect scenario|trace|legacy FILE... (validation only; never executes or builds Java)",
  );
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
