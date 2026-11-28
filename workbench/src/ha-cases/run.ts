import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { HaCluster } from "../ha-fixture/cluster.js";
import { docker } from "../ha-fixture/docker.js";
import { haImages } from "../ha-fixture/images.js";
import type { CaseContext } from "./context.js";
import { faultCases, validateManifest } from "./manifest.js";
import { verifyPreparation, workbenchRoot, sha256 } from "./prepared.js";
import {
  options,
  Observations,
  verifyCleanup,
  failure,
} from "./runner-support.js";
import { case1, case2, case3, case4, case5, case6 } from "./process-cases.js";
import { case7, case8 } from "./ordering-cases.js";
import { case9, case10, case11, case12 } from "./semantic-cases.js";
import { case13, case14 } from "./proxy-cases.js";
const implementations = [
  case1,
  case2,
  case3,
  case4,
  case5,
  case6,
  case7,
  case8,
  case9,
  case10,
  case11,
  case12,
  case13,
  case14,
];
interface Result {
  id: number;
  name: string;
  status: "passed" | "failed";
  phase: "setup" | "scenario" | "cleanup" | "complete";
  durationMillis: number;
  observations: number;
  observationsPath: string;
  observationsSha256: string;
  cleanup: string;
  failures: { phase: string; name: string; message: string }[];
}
function cancelled(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    else
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
  });
}
async function pauseRunning(
  cluster: HaCluster,
  signal: AbortSignal,
): Promise<number> {
  const paused = [];
  try {
    for (const node of cluster.nodes) {
      const status = await docker(
        [
          "exec",
          node.container,
          "sh",
          "-c",
          'if test -f /run/ha/java.pid; then pid=$(cat /run/ha/java.pid); if test -r "/proc/$pid/status"; then cat "/proc/$pid/status"; fi; fi',
        ],
        undefined,
        signal,
      );
      const state = /^State:\s+([A-Z])/m.exec(status)?.[1];
      if (!state || state === "T" || state === "Z") continue;
      await node.pause();
      paused.push(node);
    }
    await delay(75, undefined, { signal });
  } finally {
    for (const node of paused) {
      if (!signal.aborted) await node.resume();
    }
  }
  return paused.length;
}
async function main(): Promise<void> {
  const args = options(process.argv.slice(2));
  validateManifest();
  const identity = await verifyPreparation(
    args.cases.some((id) => [3, 7, 8].includes(id)),
  );
  await mkdir(dirname(args.output), { recursive: true });
  await mkdir(args.output); // Existing output is never reused or overwritten.
  const interrupted = new AbortController();
  const stop = () => interrupted.abort(new Error("HA harness interrupted"));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const report = {
    format: 1,
    purpose: "bounded-real-fault-harness",
    qualification: false,
    publicationAllowlist: [
      "report.json",
      "case-*/observations.jsonl",
      "case-*/fixture/cleanup-verified.txt",
    ],
    privateFixtureArtifacts:
      "Fixture directories contain ephemeral credentials and keys; do not publish or upload them.",
    startedAt: new Date().toISOString(),
    identity,
    variation: args.extraPauses ? "extra-process-pauses" : "normal",
    pauseMillis: args.extraPauses ? 75 : 0,
    manifest: faultCases.filter((item) => args.cases.includes(item.id)),
    results: [] as Result[],
    status: "running",
  };
  const persist = () =>
    writeFile(
      join(args.output, "report.json"),
      JSON.stringify(report, null, 2) + "\n",
    );
  await persist();
  try {
    for (const id of args.cases) {
      interrupted.signal.throwIfAborted();
      const item = faultCases[id - 1],
        start = performance.now();
      const caseDirectory = join(
          args.output,
          `case-${String(id).padStart(2, "0")}-${item.name}`,
        ),
        fixtureDirectory = join(caseDirectory, "fixture");
      await mkdir(caseDirectory);
      await mkdir(fixtureDirectory);
      const observations = new Observations(
        join(caseDirectory, "observations.jsonl"),
      );
      const result: Result = {
        id,
        name: item.name,
        status: "failed",
        phase: "setup",
        durationMillis: 0,
        observations: 0,
        observationsPath: relative(args.output, observations.path),
        observationsSha256: "",
        cleanup: "pending",
        failures: [],
      };
      const lifetime = new AbortController(),
        deadline = AbortSignal.any([
          interrupted.signal,
          AbortSignal.timeout(item.timeoutMillis),
        ]),
        signal = AbortSignal.any([deadline, lifetime.signal]);
      let cluster: HaCluster | undefined;
      try {
        cluster = await HaCluster.open({
          mode: item.mode,
          configuration: item.configuration,
          jar: identity.service.path,
          dist: join(workbenchRoot, "dist"),
          images: haImages,
          signal,
          directory: fixtureDirectory,
          faultAgent: [3, 7, 8].includes(id)
            ? identity.faultAgent!.path
            : undefined,
        });
        result.phase = "scenario";
        const active = cluster;
        const context: CaseContext = {
          cluster: active,
          signal,
          record: (name, data) => observations.record(name, data),
          pause: async () => {
            if (args.extraPauses) {
              const processes = await pauseRunning(active, signal);
              observations.record("extra-process-pause", {
                millis: "75",
                processes: String(processes),
              });
            }
          },
          cancel: async () => {
            lifetime.abort(new Error("Fixture cancellation requested by case"));
            await active.close();
            await verifyCleanup(fixtureDirectory);
            observations.record("fixture-cancelled");
          },
        };
        await context.pause();
        await Promise.race([
          implementations[id - 1](context),
          cancelled(deadline),
        ]);
        result.status = "passed";
      } catch (error) {
        result.failures.push({ phase: result.phase, ...failure(error) });
      } finally {
        lifetime.abort(new Error("Case completed"));
        try {
          await cluster?.close();
          result.cleanup = await verifyCleanup(fixtureDirectory);
        } catch (error) {
          result.status = "failed";
          if (!result.failures.length) result.phase = "cleanup";
          result.failures.push({ phase: "cleanup", ...failure(error) });
          result.cleanup = "failed";
        }
        result.observations = observations.close();
        result.observationsSha256 = await sha256(observations.path);
        result.durationMillis = Math.round(performance.now() - start);
        result.phase = result.failures.length ? result.phase : "complete";
        report.results.push(result);
        await persist();
      }
      console.log(`Case ${id}: ${result.status} (${result.durationMillis} ms)`);
      if (result.status === "failed") break;
    }
  } catch (error) {
    report.status = "failed";
    await writeFile(
      join(args.output, "interruption.json"),
      JSON.stringify(failure(error), null, 2) + "\n",
    );
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    report.status =
      report.results.length === args.cases.length &&
      report.results.every((item) => item.status === "passed")
        ? "passed"
        : "failed";
    await persist();
  }
  if (report.status !== "passed") process.exitCode = 1;
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
