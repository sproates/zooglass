import assert from "node:assert/strict";
import type { DocumentRun } from "../src/timeline/campaign-checks.js";

export type RecoveryEnvironment = {
  common: DocumentRun["environment"];
  sqliteVersion?: string;
};

/** Cross-storage aggregation only. Individual run/replay identities remain exact. */
export function includeRecoveryEnvironment(
  previous: RecoveryEnvironment | undefined,
  environment: DocumentRun["environment"],
  storage: "memory" | "sqlite",
): RecoveryEnvironment {
  assert.ok(
    storage === "memory" || storage === "sqlite",
    "Unknown qualification storage",
  );
  const java = { ...environment.java };
  const sqliteVersion = java.sqliteVersion;
  if (storage === "memory") {
    assert.ok(
      !Object.hasOwn(java, "sqliteVersion"),
      "Memory environment must omit SQLite version",
    );
  } else {
    assert.ok(
      typeof sqliteVersion === "string" && sqliteVersion.trim().length > 0,
      "SQLite environment requires a nonempty native version",
    );
    if (previous?.sqliteVersion !== undefined)
      assert.equal(
        sqliteVersion,
        previous.sqliteVersion,
        "SQLite native version drift",
      );
  }
  // No other Java or Node identity field is removed, defaulted or normalized.
  delete java.sqliteVersion;
  const common = { ...environment, java };
  if (previous)
    assert.deepEqual(
      common,
      previous.common,
      "Common recovery environment drift",
    );
  const retainedVersion =
    storage === "sqlite" ? sqliteVersion : previous?.sqliteVersion;
  return {
    common,
    ...(retainedVersion === undefined
      ? {}
      : { sqliteVersion: retainedVersion }),
  };
}
