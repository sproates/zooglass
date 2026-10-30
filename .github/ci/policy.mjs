// Policy is loaded from origin/main by select.mjs, never from the PR's working tree.
const slowSuites = new Set(["browser", "native", "engines"]);

export function validatePolicy(policy) {
  if (policy?.version !== 1 || !Array.isArray(policy.batches))
    throw new Error("Invalid batch policy");
  const branches = new Set();
  for (const batch of policy.batches) {
    if (
      !/^integration\/[a-z0-9][a-z0-9/-]*$/.test(batch.branch ?? "") ||
      branches.has(batch.branch)
    ) {
      throw new Error("Invalid or duplicate integration branch");
    }
    branches.add(batch.branch);
    for (const key of ["repository", "owner", "reason", "checkpoint"]) {
      if (typeof batch[key] !== "string" || !batch[key].trim())
        throw new Error(`Missing ${key}`);
    }
    if (
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(batch.expiresAt ?? "") ||
      !Number.isFinite(Date.parse(batch.expiresAt))
    )
      throw new Error("Invalid expiry");
    if (
      !Array.isArray(batch.defer) ||
      !batch.defer.length ||
      batch.defer.some((name) => !slowSuites.has(name))
    )
      throw new Error("Only slow suites may be deferred");
  }
  return policy;
}

export function applyBatchPolicy(
  plan,
  {
    policy,
    base,
    repository,
    headRepository,
    now = Date.now(),
    forceFull = false,
  },
) {
  validatePolicy(policy);
  if (forceFull || base === "main" || headRepository !== repository)
    return plan;
  const batch = policy.batches.find(
    (entry) => entry.branch === base && entry.repository === repository,
  );
  if (!batch || Date.parse(batch.expiresAt) <= now) return plan;
  for (const name of batch.defer) {
    if (plan[name] && !plan.mandatory.includes(name)) {
      plan[name] = false;
      plan.deferred[name] =
        `${batch.reason}; owner ${batch.owner}; expires ${batch.expiresAt}; checkpoint: ${batch.checkpoint}`;
    }
  }
  return plan;
}

export function isFinalCheckpoint(event) {
  return (
    event.pull_request?.base.ref === "main" &&
    event.pull_request?.head.ref?.startsWith("integration/")
  );
}

export function applyMainPushPolicy(plan) {
  for (const name of slowSuites) {
    if (plan[name]) {
      plan[name] = false;
      plan.deferred[name] =
        "Main push runs fast checks; browser/platform validation belongs to PR checkpoints and manual full runs.";
    }
  }
  return plan;
}
