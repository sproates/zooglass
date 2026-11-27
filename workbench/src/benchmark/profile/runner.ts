import { intervalActivity } from "./interval.js";
import { execFile } from "node:child_process";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { captureArm, epochOffset } from "./arm.js";
import { baseline } from "../workload.js";
import { measure } from "../metrics.js";
import {
  executionIdentity,
  javaOptions,
  serviceDirectory,
  hostConditions,
  fileHash,
} from "../campaign/identity.js";
import { verifyOwnership } from "../campaign/ownership.js";
import { inventory } from "../campaign/journal-files.js";
import { observations, writeJson } from "../campaign/evidence.js";
import { profileSettings, analyseRecording } from "./recording.js";

const exec = promisify(execFile);
const measuredJar =
  "ff35ccd771993ea537b9d5887415fb5358acbf6a35061830bd6176c5cebaab90";
export const profileProtocol = (smoke: boolean) =>
  smoke
    ? {
        rate: 100,
        settleMs: 50,
        warmupMs: 2000,
        measurementMs: 10000,
        drainMs: 10000,
        innerStartMs: 2000,
        innerEndMs: 8000,
      }
    : {
        rate: 300,
        settleMs: 60000,
        warmupMs: 30000,
        measurementMs: 60000,
        drainMs: 10000,
        innerStartMs: 20000,
        innerEndMs: 50000,
      };

/** One finite pair. Raw failures are retained; this never classifies service capacity. */
export async function runProfilePair(
  directory: string,
  conditions: string,
  smoke: boolean,
  lockFd: number,
  cancellation: AbortSignal,
) {
  verifyOwnership(directory, lockFd);
  if (
    !conditions.trim() ||
    (await readdir(directory)).some((name) => name !== ".lock")
  )
    throw new Error(
      "Profile requires observed conditions and a new locked directory",
    );
  const signal = AbortSignal.any([
    cancellation,
    AbortSignal.timeout(12 * 60 * 1000),
  ]);
  const checkpoint = async () => {
    signal.throwIfAborted();
  };
  let complete = false;
  let activeArm: string | undefined;
  let error: string | undefined;
  const startedArms: string[] = [];
  const summaries = new Map<
    string,
    { target: string; measurementStartMs: number }
  >();
  try {
    if (/[\n\r,=]/.test(directory))
      throw new Error("Unsupported JFR output path");
    const identity = await executionIdentity(directory, checkpoint);
    if (!smoke && identity.serviceJar !== measuredJar)
      throw new Error(
        "Diagnostic requires the retained measured service JAR; use --smoke only for tooling checks",
      );
    const jfr = process.env.JAVA_HOME
      ? join(process.env.JAVA_HOME, "bin/jfr")
      : "jfr";
    const metadata = await exec(
      jfr,
      ["metadata", "--events", "jdk.MethodTiming"],
      { timeout: 5000, signal, maxBuffer: 1024 * 1024 },
    );
    if (
      !metadata.stdout.includes("class MethodTiming") ||
      !/version "25[."]/.test(identity.jvm)
    )
      throw new Error(
        "SQLite profiling requires a Java 25 JDK with MethodTiming",
      );
    const protocol = profileProtocol(smoke);
    const manifest = {
      format: "sqlite-profile/v1",
      startedUtc: new Date().toISOString(),
      smoke,
      protocol,
      identity,
      conditions: hostConditions(conditions),
      plan: ["unprofiled", "profiled"],
      capacityAssessment: "not-run",
    };
    await writeJson(join(directory, "manifest.json"), manifest);
    for (const arm of manifest.plan) {
      activeArm = arm;
      await checkpoint();
      await delay(protocol.settleMs, undefined, { signal });
      const target = join(directory, arm);
      await mkdir(target);
      startedArms.push(arm);
      const attemptSignal = AbortSignal.any([
        signal,
        AbortSignal.timeout(5 * 60 * 1000),
      ]);
      const checkAttempt = async () => {
        attemptSignal.throwIfAborted();
      };
      const profiled = arm === "profiled";
      const settingsPath = join(target, "settings.jfc");
      const recordingPath = join(target, "methods.jfr");
      if (profiled)
        await writeFile(settingsPath, profileSettings, { flag: "wx" });
      const options = [
        ...javaOptions,
        ...(profiled
          ? [
              `-XX:StartFlightRecording=name=sqlite-profile,settings=${settingsPath},filename=${recordingPath},dumponexit=true,maxsize=128m`,
            ]
          : []),
      ];
      await writeJson(join(target, "input.json"), {
        arm,
        protocol,
        javaOptions: options,
        workload: { ...baseline, storage: "sqlite" },
        serviceJar: identity.serviceJar,
      });
      const { report, anchors, measurementStartMs } = await captureArm(target, {
        workload: { ...baseline, storage: "sqlite" },
        rate: protocol.rate,
        warmupMs: protocol.warmupMs,
        measurementMs: protocol.measurementMs,
        drainMs: protocol.drainMs,
        serviceDirectory,
        databasePath: join(target, "store.sqlite"),
        javaOptions: options,
        inheritedLockFd: lockFd,
        signal: attemptSignal,
      });
      const metrics = await measure(
        report,
        observations(join(target, "observations.jsonl"), checkAttempt),
      );
      await writeJson(join(target, "metrics.json"), metrics);
      let timing: ReturnType<typeof analyseRecording> | null = null;
      if (profiled) {
        const { size } = await stat(recordingPath);
        if (!size || size > 160 * 1024 * 1024)
          throw new Error("Missing or oversized method recording");
        const printed = await exec(
          jfr,
          ["print", "--json", "--events", "jdk.MethodTiming", recordingPath],
          {
            timeout: 30000,
            maxBuffer: 32 * 1024 * 1024,
            signal: attemptSignal,
            killSignal: "SIGKILL",
          },
        );
        await writeFile(join(target, "methods.json"), printed.stdout, {
          flag: "wx",
        });
        const offset = epochOffset(anchors);
        timing = analyseRecording(JSON.parse(printed.stdout), {
          startEpochMs: measurementStartMs + protocol.innerStartMs + offset,
          endEpochMs: measurementStartMs + protocol.innerEndMs + offset,
        });
        await writeJson(join(target, "timing.json"), timing);
        // Match the control to the actual JFR ticks, relative to each arm's measurement origin.
        const relativeStartMs =
          timing.startEpochMs - offset - measurementStartMs;
        const relativeEndMs = timing.endEpochMs - offset - measurementStartMs;
        const control = summaries.get("unprofiled")!;
        const counts = async (dir: string, origin: number) =>
          intervalActivity(
            observations(join(dir, "observations.jsonl"), checkAttempt),
            origin + relativeStartMs,
            origin + relativeEndMs,
          );
        const unprofiled = await counts(
          control.target,
          control.measurementStartMs,
        );
        const profiledCounts = await counts(target, measurementStartMs);
        await writeJson(join(directory, "comparison.json"), {
          relativeStartMs,
          relativeEndMs,
          unprofiled,
          profiled: profiledCounts,
          methodInvocations: Object.fromEntries(
            Object.entries(timing.methods).map(([k, v]) => [k, v.invocations]),
          ),
          limitation:
            "Callbacks and completed method invocations may straddle interval boundaries.",
        });
      }
      await writeJson(
        join(directory, `${arm}-inventory.json`),
        await inventory(
          target,
          (await readdir(target)).filter((n) => n !== "input.json"),
          false,
          checkAttempt,
        ),
      );
      await writeJson(join(directory, `${arm}-summary.json`), {
        arm,
        inputHash: await fileHash(join(target, "input.json"), checkAttempt),
        driverStatus: report.status,
        error: report.error,
        metrics,
        timing,
        capacityAssessment: "not-run",
      });
      summaries.set(arm, { target, measurementStartMs });
      attemptSignal.throwIfAborted();
    }
    complete = true;
  } catch (cause) {
    error = String(signal.aborted ? signal.reason : cause);
    throw cause;
  } finally {
    await writeJson(join(directory, "completion.json"), {
      complete,
      endedUtc: new Date().toISOString(),
      armsStarted: startedArms,
      armsRetained: summaries.size,
      ...(error ? { error, interruptedArm: activeArm } : {}),
      assessment:
        "diagnostic only; inspect workload, backlog recurrence and observer effects before attributing time",
    });
  }
}
