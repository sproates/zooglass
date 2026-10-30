import test from "node:test";
import assert from "node:assert/strict";
import { validationMode } from "./branches.mjs";

const pr = (head, base = "feature/strategies") => ({
  pull_request: { head: { ref: head }, base: { ref: base } },
});

test("whole branch segments select development shortcuts", () => {
  for (const branch of [
    "feature/no-ci/strategies",
    "no-ci",
    "feature/NO-CI/x",
  ]) {
    assert.equal(validationMode(pr(branch), "pull_request"), "none");
  }
  assert.equal(
    validationMode(
      pr("fix/slice", "feature/core-ci/strategies"),
      "pull_request",
    ),
    "core",
  );
  assert.equal(
    validationMode(pr("feature/core-ci/strategies"), "pull_request"),
    "core",
  );
  assert.equal(
    validationMode(pr("feature/no-ci/x", "feature/core-ci/x"), "pull_request"),
    "none",
  );
  for (const branch of [
    "feature/not-no-ci/x",
    "feature/core-ci-tools",
    "feature/ordinary",
  ]) {
    assert.equal(validationMode(pr(branch), "pull_request"), "selected");
  }
});

test("main ignores both shortcuts and uses the baseline", () => {
  for (const branch of [
    "feature/no-ci/x",
    "feature/core-ci/x",
    "feature/ordinary",
  ]) {
    assert.equal(
      validationMode(pr(branch, "main"), "pull_request"),
      "selected",
    );
  }
});

test("manual runs use the requested scope, independently of branch names", () => {
  assert.equal(validationMode({ inputs: {} }, "workflow_dispatch"), "full");
  assert.equal(
    validationMode({ inputs: { mode: "selected" } }, "workflow_dispatch"),
    "selected",
  );
});
