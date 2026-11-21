import { stat, realpath } from "node:fs/promises";
import { relative, isAbsolute, sep } from "node:path";
import { boundedFile, decode } from "./admission.js";
import { readBundle } from "./artifact-bundle.js";
import { encodeJson } from "./json.js";
import { parseReplay } from "./replay-document.js";

type Run = ReturnType<typeof parseReplay>;

/** Compare saved evidence only: equality is neither re-execution nor a passing outcome. */
export function compareRuns(left: Run, right: Run) {
  const mismatches = [
    ["scenario", left.saved.scenario, right.saved.scenario],
    ["configuration", left.saved.configuration, right.saved.configuration],
    ["execution", left.execution, right.execution],
    ["environment", left.saved.environment, right.saved.environment],
  ]
    .filter(([, a, b]) => encodeJson(a) !== encodeJson(b))
    .map(([label]) => label);
  const common = {
    format: "timeline-comparison/v1",
    executionVerified: false,
    leftOutcome: left.outcome,
    rightOutcome: right.outcome,
  };
  if (mismatches.length)
    return { ...common, status: "incompatible", mismatches };
  const length = Math.max(left.lines.length, right.lines.length);
  for (let record = 0; record < length; record++) {
    if (left.lines[record] !== right.lines[record])
      return {
        ...common,
        status: "different",
        matchedRecords: record,
        difference: {
          record,
          left: left.lines[record] ?? null,
          right: right.lines[record] ?? null,
        },
      };
  }
  return { ...common, status: "equal", matchedRecords: length };
}

export async function readComparisonInput(path: string, destination: string) {
  if ((await stat(path)).isDirectory()) {
    const distance = relative(await realpath(path), destination);
    if (
      !distance ||
      (!isAbsolute(distance) &&
        distance !== ".." &&
        !distance.startsWith(".." + sep))
    )
      throw new Error("Comparison report must be outside input bundles");
    return readBundle(path);
  }
  return parseReplay(decode(await boundedFile(path)));
}
