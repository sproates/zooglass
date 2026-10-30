import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const script = fileURLToPath(new URL("./select.mjs", import.meta.url));

test("real git diff includes both sides of renames, deletes, and mixed doc/code changes", (t) => {
  const root = mkdtempSync(join(tmpdir(), "ci-selection-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  const put = (path, text) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  put("README.md", "before");
  put("old module.ts", "export const value = 1;");
  put("deleted.txt", "old");
  git("add", ".");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  git("mv", "old module.ts", "new module.ts");
  git("rm", "deleted.txt");
  put("README.md", "after");
  git("add", ".");
  git("commit", "-qm", "change");
  const head = git("rev-parse", "HEAD");
  const run = (event, extra = {}) => {
    put("event.json", JSON.stringify(event));
    execFileSync(process.execPath, [script], {
      cwd: root,
      env: {
        ...process.env,
        // Fixture events must not inherit the outer Actions trigger or branch.
        GITHUB_EVENT_NAME: event.pull_request ? "pull_request" : "push",
        GITHUB_REF: "refs/heads/fixture",
        GITHUB_SHA: head,
        GITHUB_EVENT_PATH: join(root, "event.json"),
        GITHUB_OUTPUT: join(root, "output"),
        GITHUB_STEP_SUMMARY: join(root, "summary"),
        ...extra,
      },
    });
    return JSON.parse(readFileSync(join(root, "validation-plan.json")));
  };
  for (const event of [
    { before: base, after: head },
    { pull_request: { base: { sha: base }, head: { sha: head } } },
  ]) {
    const plan = run(event);
    assert.deepEqual(plan.paths.sort(), [
      "README.md",
      "deleted.txt",
      "new module.ts",
      "old module.ts",
    ]);
    assert.equal(plan.native, true);
  }
  const request = (ref, target = "feature/strategies") => ({
    pull_request: {
      base: { sha: base, ref: target },
      head: { sha: head, ref },
    },
  });
  const core = run(request("feature/core-ci/strategies"));
  assert.deepEqual(
    Object.keys(core).filter((key) => core[key] === true),
    ["java"],
  );
  const none = run(request("feature/no-ci/strategies"));
  assert.equal(Object.values(none).includes(true), false);
  for (const name of ["no-ci", "core-ci"]) {
    assert.equal(
      run(request(`feature/${name}/strategies`, "main")).browser,
      true,
    );
  }
  const manual = run(
    { inputs: { mode: "full", compare_ref: base } },
    { GITHUB_EVENT_NAME: "workflow_dispatch" },
  );
  assert.equal(manual.native, true);

  // A docs-only diff still stays cheap when a shortcut branch targets main.
  put("README.md", "documentation only");
  git("add", "README.md");
  git("commit", "-qm", "docs");
  const docsHead = git("rev-parse", "HEAD");
  const docs = run({
    pull_request: {
      base: { sha: head, ref: "main" },
      head: { sha: docsHead, ref: "feature/no-ci/docs" },
    },
  });
  assert.equal(Object.values(docs).includes(true), false);

  const fallback = run({ before: "0".repeat(40), after: head });
  assert.equal(fallback.java, true);
  assert.equal(fallback.browser, true);
  assert.match(fallback.reasons[0], /Cannot safely classify/);
});
