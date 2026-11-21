import assert from "node:assert/strict";
import test from "node:test";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { auditRecoveryEvidence } from "../../scripts/recovery-audit.js";
import { digest } from "../../scripts/recovery-evidence.js";

const evidence = process.env.ZOOGLASS_RECOVERY_EVIDENCE;
test(
  "offline recovery audit rejects tampering after summary hashes are recomputed",
  { skip: !evidence },
  async () => {
    assert.equal(
      (await auditRecoveryEvidence(evidence!)).scenarioExecutions,
      28,
    );
    for (const mutation of [
      "trace",
      "pause",
      "replay",
      "configuration",
      "count",
      "service",
      "control",
      "host",
      "environment",
    ] as const) {
      const root = await mkdtemp(join(tmpdir(), "recovery-audit-"));
      const directory = join(root, "evidence");
      const json = async (path: string) =>
        JSON.parse(await readFile(path, "utf8"));
      const save = (path: string, value: unknown) =>
        writeFile(path, JSON.stringify(value, null, 2) + "\n");
      try {
        await cp(evidence!, directory, { recursive: true });
        const summaryPath = join(directory, "campaign/summary.json");
        const summary = await json(summaryPath);
        if (mutation === "trace" || mutation === "pause") {
          const row = summary.rows[1];
          const path = join(directory, "campaign", row.file);
          const run = await json(path);
          if (mutation === "pause")
            run.diagnostics.generations[1].jvm.pauses = [];
          else
            run.trace = run.trace.replace(
              '"temperatureC":760',
              '"temperatureC":999',
            );
          await save(path, run);
          row.sha256 = digest(await readFile(path));
          row.traceSha256 = digest(run.trace);
          await save(summaryPath, summary);
        } else if (mutation === "replay") {
          await rm(join(directory, "campaign", summary.rows[0].replayFile));
        } else if (mutation === "configuration") {
          const path = join(directory, "campaign/inputs/m1/runtime.json");
          await writeFile(path, (await readFile(path, "utf8")) + " ");
          summary.source.files.find(
            (entry: { path: string }) =>
              entry.path ===
              "scenarios/timeline-static-recovery/m1/runtime.json",
          ).sha256 = digest(await readFile(path));
          await save(summaryPath, summary);
        } else if (mutation === "count") {
          summary.attemptedExecutions = 23;
          await save(summaryPath, summary);
        } else if (mutation === "service") {
          const path = join(directory, "service-s1/evidence.json");
          const service = await json(path);
          service.complete = false;
          await save(path, service);
        } else if (mutation === "host" || mutation === "environment") {
          const path = join(directory, "control/normal.json");
          const normal = await json(path);
          if (mutation === "host")
            normal.execution.artifactSha256 = "f".repeat(64);
          else normal.environment.node = "different-node";
          await save(path, normal);
        } else {
          const path = join(directory, "control/mutant.json");
          const mutant = await json(path);
          mutant.message = "assertion-failed: wrong-checkpoint";
          await save(path, mutant);
        }
        await assert.rejects(auditRecoveryEvidence(directory), mutation);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  },
);
