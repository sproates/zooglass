import { appendFileSync } from "node:fs";
import { requiredResultErrors } from "./selection.mjs";
const plan = JSON.parse(process.env.PLAN);
const results = JSON.parse(process.env.RESULTS);
const groups = JSON.parse(process.env.GROUPS);
const errors = requiredResultErrors(plan, results, groups);
const summary = errors.length
  ? errors.join("\n")
  : "All selected checks passed.";
if (process.env.GITHUB_STEP_SUMMARY)
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `## Validation result\n\n${summary}\n`,
  );
console.log(summary);
if (errors.length) process.exitCode = 1;
