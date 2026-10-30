import { execFileSync } from "node:child_process";
import { readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { selectChecks } from "./selection.mjs";
import { validationMode } from "./branches.mjs";

const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
const eventName =
  process.env.GITHUB_EVENT_NAME ??
  (event.pull_request ? "pull_request" : "push");
const git = (...args) =>
  execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
const revision = (...args) => git(...args).trim();
let paths = [];
let base;
let head;
const mode = validationMode(event, eventName);
let forceFull = mode === "full";
let fallback = "";
try {
  if (event.pull_request) {
    base = revision(
      "merge-base",
      event.pull_request.base.sha,
      event.pull_request.head.sha,
    );
    head = event.pull_request.head.sha;
  } else if (eventName === "workflow_dispatch") {
    head = process.env.GITHUB_SHA;
    const compare = event.inputs?.compare_ref || "origin/main";
    const compareSha = revision(
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${compare}^{commit}`,
    );
    base = revision("merge-base", compareSha, head);
  } else {
    base = event.before;
    head = event.after;
  }
  if (!/^[a-f0-9]{40}$/.test(base ?? "") || /^0+$/.test(base))
    throw new Error("No valid base");
  if (!/^[a-f0-9]{40}$/.test(head ?? "")) throw new Error("No valid head");
  paths = git("diff", "--name-only", "--no-renames", "-z", base, head)
    .split("\0")
    .filter(Boolean);
} catch (error) {
  forceFull = true;
  fallback = `Cannot safely classify diff; using full validation: ${error.message}`;
}
let plan = selectChecks(paths, { forceFull });
if (fallback) plan.reasons.unshift(fallback);
if (mode === "full") plan.reasons.unshift("Full validation required.");
if (mode === "core" || mode === "none") {
  plan = selectChecks([]);
  plan.java = mode === "core";
  plan.paths = paths;
  plan.reasons = [
    mode === "core"
      ? "core-ci: ZooGlass tests only."
      : "no-ci: checks disabled.",
  ];
}
plan.evidence = {
  event: eventName,
  base,
  head,
  testedCommit: process.env.GITHUB_SHA ?? revision("rev-parse", "HEAD"),
};
writeFileSync("validation-plan.json", JSON.stringify(plan, null, 2));
appendFileSync(process.env.GITHUB_OUTPUT, `plan=${JSON.stringify(plan)}\n`);
appendFileSync(
  process.env.GITHUB_STEP_SUMMARY,
  "## Validation selection\n\n" +
    Object.entries(plan)
      .filter(([, value]) => typeof value === "boolean")
      .map(
        ([name, required]) =>
          `- **${name}**: ${required ? "required" : mode === "core" ? "skipped by core-ci" : "not applicable"}`,
      )
      .join("\n") +
    `\n\nTested commit: ${plan.evidence.testedCommit}\n\n` +
    plan.reasons.map((reason) => `- ${reason.replaceAll("`", "")}`).join("\n") +
    "\n",
);
