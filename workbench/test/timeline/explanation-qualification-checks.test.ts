import assert from "node:assert/strict";
import test from "node:test";
import type { DocumentRun } from "../../src/timeline/campaign-checks.js";
import { checkExplanationPauses } from "../../scripts/explanation-checks.js";

// Synthetic diagnostics exercise the checker; only campaign runs are execution evidence.
function diagnostics(storage: "memory" | "sqlite", paused: boolean) {
  return {
    trace: "same",
    configuration: JSON.stringify({ storage }),
    environment: {},
    diagnostics: {
      generations: [1, 2].map((runtimeGeneration) => ({
        runtimeGeneration,
        jvm: {
          pauseMillis: paused ? 70 : 0,
          pauses: !paused
            ? []
            : (runtimeGeneration === 1
                ? [
                    ["writer-handoff", 0],
                    ["state-effect", 10],
                  ]
                : storage === "memory"
                  ? [["state-effect", 70]]
                  : []
              ).map(([site, virtualMs]) => ({
                site,
                virtualMs,
                requestedMillis: 70,
                elapsedNanos: 71_000_000,
              })),
        },
        node: !paused
          ? []
          : (runtimeGeneration === 1
              ? [
                  ["initialize-document", 0],
                  ["ingress", 10],
                  ["ingress", 20],
                  ["ingress", 30],
                  ["ingress", 40],
                ]
              : [
                  ["initialize-document", 60],
                  ["ingress", 70],
                  ["ingress", 80],
                ]
            ).map(([operation, timeMs], turn) => ({
              operation,
              timeMs,
              turn,
              requestedMillis: 70,
              elapsedNanos: 71_000_000,
            })),
      })),
    },
  } as DocumentRun;
}

test("pause checker requires complete generation and Node witnesses", () => {
  const normal = diagnostics("memory", false),
    paused = diagnostics("memory", true);
  assert.equal(checkExplanationPauses(normal, paused), 3);
  const missingJvm = structuredClone(paused);
  missingJvm.diagnostics.generations![1].jvm = null;
  assert.throws(() => checkExplanationPauses(normal, missingJvm), /JVM/);
  const missingNode = structuredClone(paused);
  missingNode.diagnostics.generations!.forEach(
    (generation) => (generation.node = []),
  );
  assert.throws(() => checkExplanationPauses(normal, missingNode), /Node/);
  const wrongTime = structuredClone(paused);
  wrongTime.diagnostics.generations![1].jvm!.pauses[0].virtualMs = 10;
  assert.throws(() => checkExplanationPauses(normal, wrongTime), /JVM/);
  const missingGeneration = structuredClone(paused);
  missingGeneration.diagnostics.generations!.pop();
  assert.throws(
    () => checkExplanationPauses(normal, missingGeneration),
    /generation/,
  );
  const unpaused = diagnostics("sqlite", false),
    sqlite = diagnostics("sqlite", true);
  assert.equal(checkExplanationPauses(unpaused, sqlite), 2);
});

test("audit JSON rejects symlinks and oversized metadata before parsing", async () => {
  const { mkdtemp, writeFile, symlink, open, rm } =
    await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { readExplanationJson } =
    await import("../../scripts/explanation-evidence.js");
  const directory = await mkdtemp(join(tmpdir(), "explanation-audit-input-"));
  try {
    const valid = join(directory, "valid.json"),
      link = join(directory, "link.json"),
      large = join(directory, "large.json");
    await writeFile(valid, '{"complete":true}');
    assert.deepEqual(await readExplanationJson(valid), { complete: true });
    await symlink(valid, link);
    await assert.rejects(readExplanationJson(link), /regular file/);
    const file = await open(large, "w");
    try {
      await file.truncate(16 * 1024 * 1024 + 1);
    } finally {
      await file.close();
    }
    await assert.rejects(readExplanationJson(large), /byte limit/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
