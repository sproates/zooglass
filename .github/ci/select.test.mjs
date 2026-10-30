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
  const run = (event) => {
    put("event.json", JSON.stringify(event));
    execFileSync(process.execPath, [script], {
      cwd: root,
      env: {
        ...process.env,
        GITHUB_EVENT_PATH: join(root, "event.json"),
        GITHUB_OUTPUT: join(root, "output"),
        GITHUB_STEP_SUMMARY: join(root, "summary"),
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
  const fallback = run({ before: "0".repeat(40), after: head });
  assert.equal(fallback.java, true);
  assert.equal(fallback.browser, true);
  assert.match(fallback.reasons[0], /Cannot safely classify/);
});
