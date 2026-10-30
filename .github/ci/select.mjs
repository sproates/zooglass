import { execFileSync } from "node:child_process";
import { readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { selectChecks } from "./selection.mjs";

const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
let paths = [];
let forceFull = false;
let explanation = "";
try {
  let base;
  let head;
  if (event.pull_request) {
    base = git(
      "merge-base",
      event.pull_request.base.sha,
      event.pull_request.head.sha,
    );
    head = event.pull_request.head.sha;
  } else {
    base = event.before;
    head = event.after;
  }
  if (!/^[a-f0-9]{40}$/.test(base ?? "") || /^0+$/.test(base))
    throw new Error("No valid base");
  if (!/^[a-f0-9]{40}$/.test(head ?? "")) throw new Error("No valid head");
  // No rename detection: both old and new paths participate in selection.
  paths = git("diff", "--name-only", "--no-renames", "-z", base, head)
    .split("\0")
    .filter(Boolean);
} catch (error) {
  forceFull = true;
  explanation = `Cannot safely classify diff; using full validation: ${error.message}`;
}
const plan = selectChecks(paths, { forceFull });
if (explanation) plan.reasons.unshift(explanation);
writeFileSync("validation-plan.json", JSON.stringify(plan, null, 2));
appendFileSync(process.env.GITHUB_OUTPUT, `plan=${JSON.stringify(plan)}\n`);
appendFileSync(
  process.env.GITHUB_STEP_SUMMARY,
  "## Validation selection\n\n" +
    Object.entries(plan)
      .filter(([, value]) => typeof value === "boolean")
      .map(
        ([name, required]) =>
          `- **${name}**: ${required ? "required" : "not applicable"}`,
      )
      .join("\n") +
    "\n\n" +
    plan.reasons.map((reason) => `- ${reason.replaceAll("`", "")}`).join("\n") +
    "\n",
);
