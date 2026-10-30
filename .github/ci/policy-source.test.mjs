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

test("CLI reads only trusted main policy; manual full and final PR restore all suites", (t) => {
  const root = mkdtempSync(join(tmpdir(), "ci-policy-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const put = (file, value) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), value);
  };
  git("init", "-q");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  const path = "zooglass/src/main/java/io/zooglass/LiveViewBroadcaster.java";
  put(path, "// base");
  put(
    ".github/ci/batches.json",
    JSON.stringify({
      version: 1,
      batches: [
        {
          branch: "integration/test",
          repository: "sproates/zooglass",
          owner: "sproates",
          reason: "Contract batch",
          checkpoint: "Full final PR",
          expiresAt: "2099-01-01T00:00:00Z",
          defer: ["browser"],
        },
      ],
    }),
  );
  git("add", ".");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  git("update-ref", "refs/remotes/origin/main", base);
  put(path, "// changed");
  git("add", path);
  git("commit", "-qm", "slice");
  const head = git("rev-parse", "HEAD");
  // A malicious/unreviewed working-tree policy must not replace the trusted entry.
  put(".github/ci/batches.json", "not valid JSON");
  const pr = {
    pull_request: {
      base: { sha: base, ref: "integration/test" },
      head: {
        sha: head,
        ref: "feature/slice",
        repo: { full_name: "sproates/zooglass" },
      },
    },
  };
  const run = (event, extra = {}) => {
    put("event.json", JSON.stringify(event));
    execFileSync(process.execPath, [script], {
      cwd: root,
      env: {
        ...process.env,
        GITHUB_EVENT_PATH: join(root, "event.json"),
        GITHUB_OUTPUT: join(root, "output"),
        GITHUB_STEP_SUMMARY: join(root, "summary"),
        GITHUB_REPOSITORY: "sproates/zooglass",
        GITHUB_SHA: head,
        GITHUB_REF: "refs/pull/1/merge",
        GITHUB_EVENT_NAME: "pull_request",
        ...extra,
      },
    });
    return JSON.parse(readFileSync(join(root, "validation-plan.json")));
  };
  assert.equal(run(pr).browser, false);
  assert.equal(run(pr).core, true);
  const final = structuredClone(pr);
  final.pull_request.base.ref = "main";
  final.pull_request.head.ref = "integration/test";
  assert.equal(run(final).native, true);
  assert.equal(
    run(
      { inputs: { mode: "full" } },
      { GITHUB_EVENT_NAME: "workflow_dispatch" },
    ).browser,
    true,
  );
  const selected = run(
    { inputs: { mode: "selected" } },
    { GITHUB_EVENT_NAME: "workflow_dispatch" },
  );
  assert.equal(selected.java, true);
  assert.equal(selected.native, false);
  assert.equal(selected.browser, true);
  const fork = structuredClone(pr);
  fork.pull_request.head.repo.full_name = "other/fork";
  assert.equal(run(fork).browser, true);
  git("update-ref", "-d", "refs/remotes/origin/main");
  assert.equal(run(pr).native, true);
});
