import assert from "node:assert/strict";
import test from "node:test";
import type { DocumentRun } from "../../src/timeline/campaign-checks.js";
import { includeRecoveryEnvironment } from "../../scripts/recovery-environment.js";

const memory: DocumentRun["environment"] = {
  executor: "static-views-restart-v1/1",
  node: "v26.0.0",
  v8: "14.6.202.33-node.19",
  platform: "darwin",
  arch: "arm64",
  locale: "en-US",
  timezone: "Europe/Gibraltar",
  dependencyLockSha256: "a".repeat(64),
  java: {
    arch: "aarch64",
    locale: "en-GI",
    os: "Mac OS X",
    javaVendor: "Homebrew",
    javaRuntime: "25.0.5.0.2",
    timezone: "Europe/Gibraltar",
  },
};
const sqlite = { ...memory, java: { ...memory.java, sqliteVersion: "3.53.2" } };

test("mixed-storage qualification preserves one common environment and native SQLite version", () => {
  const before = structuredClone({ memory, sqlite });
  let joined = includeRecoveryEnvironment(undefined, memory, "memory");
  joined = includeRecoveryEnvironment(joined, sqlite, "sqlite");
  joined = includeRecoveryEnvironment(joined, memory, "memory"); // B1 follows SQLite cases.
  joined = includeRecoveryEnvironment(joined, sqlite, "sqlite"); // Isolated normal control.
  assert.deepEqual(joined, { common: memory, sqliteVersion: "3.53.2" });
  assert.deepEqual(
    { memory, sqlite },
    before,
    "Never rewrite retained run identities",
  );
  assert.deepEqual(
    includeRecoveryEnvironment(
      includeRecoveryEnvironment(undefined, sqlite, "sqlite"),
      memory,
      "memory",
    ),
    joined,
  );
});

test("storage capability absence cannot mask a missing or inconsistent SQLite version", () => {
  assert.throws(
    () => includeRecoveryEnvironment(undefined, sqlite, "memory"),
    /must omit/,
  );
  assert.throws(
    () => includeRecoveryEnvironment(undefined, memory, "sqlite"),
    /nonempty native version/,
  );
  for (const version of ["", "   ", undefined]) {
    const changed = {
      ...memory,
      java: { ...memory.java, sqliteVersion: version },
    } as DocumentRun["environment"];
    assert.throws(
      () => includeRecoveryEnvironment(undefined, changed, "sqlite"),
      /nonempty native version/,
    );
    assert.throws(
      () => includeRecoveryEnvironment(undefined, changed, "memory"),
      /must omit/,
    );
  }
  const established = includeRecoveryEnvironment(undefined, sqlite, "sqlite");
  assert.throws(
    () =>
      includeRecoveryEnvironment(
        established,
        { ...sqlite, java: { ...sqlite.java, sqliteVersion: "3.53.3" } },
        "sqlite",
      ),
    /native version drift/,
  );
});

test("every other environment field remains exact across memory, SQLite and control runs", () => {
  const established = includeRecoveryEnvironment(undefined, memory, "memory");
  for (const key of Object.keys(memory).filter((key) => key !== "java")) {
    const changed = { ...sqlite, [key]: "changed" };
    assert.throws(
      () => includeRecoveryEnvironment(established, changed, "sqlite"),
      /Common recovery environment drift/,
      key,
    );
  }
  for (const key of Object.keys(memory.java)) {
    const changed = { ...sqlite, java: { ...sqlite.java, [key]: "changed" } };
    assert.throws(
      () => includeRecoveryEnvironment(established, changed, "sqlite"),
      /Common recovery environment drift/,
      key,
    );
  }
  assert.throws(
    () =>
      includeRecoveryEnvironment(
        established,
        { ...sqlite, java: { ...sqlite.java, unexpected: "extra" } },
        "sqlite",
      ),
    /Common recovery environment drift/,
  );
});
