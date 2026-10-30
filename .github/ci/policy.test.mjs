import test from "node:test";
import assert from "node:assert/strict";
import { selectChecks } from "./selection.mjs";
import {
  applyBatchPolicy,
  validatePolicy,
  isFinalCheckpoint,
  applyMainPushPolicy,
} from "./policy.mjs";
const policy = {
  version: 1,
  batches: [
    {
      branch: "integration/strategies",
      repository: "sproates/zooglass",
      owner: "sproates",
      reason: "Core contract batch",
      expiresAt: "2030-01-01T00:00:00Z",
      checkpoint: "Full final PR",
      defer: ["browser", "engines", "native"],
    },
  ],
};
const context = {
  policy,
  base: "integration/strategies",
  repository: "sproates/zooglass",
  headRepository: "sproates/zooglass",
  now: Date.parse("2026-10-30T00:00:00Z"),
};
const protocol = () =>
  selectChecks(["zooglass/src/main/java/io/zooglass/LiveViewBroadcaster.java"]);

test("approved core batch defers browser but retains Java and actual service checks", () => {
  const plan = applyBatchPolicy(protocol(), context);
  assert.equal(plan.browser, false);
  assert.equal(plan.java, true);
  assert.equal(plan.core, true);
  assert.match(plan.deferred.browser, /Full final PR/);
});
test("expiry, other branches, forks, main PRs and full override restore normal selection", () => {
  for (const override of [
    { now: Date.parse("2030-01-01T00:00:00Z") },
    { base: "integration/other" },
    { headRepository: "other/fork" },
    { base: "main" },
    { forceFull: true },
    { repository: "other/repo" },
  ]) {
    assert.equal(
      applyBatchPolicy(protocol(), { ...context, ...override }).browser,
      true,
    );
  }
});
test("direct UI, lifecycle, dependency and CI changes override deferrals", () => {
  for (const path of [
    "demos/vehicle-tracker/src/view.ts",
    "workbench/src/service/zooglass-session.ts",
    "workbench/package-lock.json",
    ".github/ci/selection.mjs",
  ]) {
    const plan = applyBatchPolicy(selectChecks([path]), context);
    assert.equal(plan.browser, true);
    assert.deepEqual(plan.deferred, {});
  }
});
test("malformed policy fails visibly, and cannot defer required core checks", () => {
  for (const value of [
    null,
    { version: 1 },
    { ...policy, batches: [{ ...policy.batches[0], defer: ["java"] }] },
    { ...policy, batches: [{ ...policy.batches[0], expiresAt: "tomorrow" }] },
    { ...policy, batches: [policy.batches[0], policy.batches[0]] },
  ]) {
    assert.throws(() => validatePolicy(value));
  }
});
test("integration-to-main always identifies a full checkpoint even without policy", () => {
  assert.equal(
    isFinalCheckpoint({
      pull_request: { base: { ref: "main" }, head: { ref: "integration/new" } },
    }),
    true,
  );
  assert.equal(
    isFinalCheckpoint({
      pull_request: { base: { ref: "main" }, head: { ref: "fix/small" } },
    }),
    false,
  );
});
test("main push avoids repeating slow checks without calling them passed", () => {
  const plan = applyMainPushPolicy(selectChecks([], { forceFull: true }));
  assert.equal(plan.java, true);
  assert.equal(plan.core, true);
  assert.equal(plan.demo, true);
  assert.equal(plan.browser, false);
  assert.match(plan.deferred.browser, /Main push/);
});
