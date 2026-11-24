import { monitorEventLoopDelay } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startZooGlassSession } from "../service/zooglass-session.js";
import { clientDiagnostic } from "./diagnostic.js";
import { baseline, Workload } from "./workload.js";
import { startResources } from "./resources.js";
import {
  executionIdentity,
  javaOptions,
  hostConditions,
} from "./campaign/identity.js";

/** Alternate pair order to avoid always measuring the sampled case after the control. */
export function diagnosticPlan(smoke = false) {
  return (smoke ? [100] : [10, 100, 300, 1000]).flatMap((rate) =>
    Array.from({ length: smoke ? 1 : 3 }, (_, repeat) =>
      (repeat % 2 ? [true, false] : [false, true]).map((sampled) => ({
        rate,
        repeat: repeat + 1,
        sampled,
        durationMs: smoke ? 1000 : 30000,
      })),
    ).flat(),
  );
}

/** A client-only controlled experiment; the real prepared JVM stays idle in both arms. */
export async function runSamplingDiagnostic(
  directory: string,
  conditions: string,
  smoke = false,
  cancellation?: AbortSignal,
) {
  if (!conditions.trim())
    throw new Error("Observed host conditions are required");
  await mkdir(directory); // Refuse overwrite, including a previous partial experiment.
  const timeout = AbortSignal.timeout(20 * 60 * 1000);
  const signal = cancellation
    ? AbortSignal.any([timeout, cancellation])
    : timeout;
  const manifest = {
    format: "sampling-diagnostic/v1",
    kind: "client-only; not a ZooGlass capacity measurement",
    startedUtc: new Date().toISOString(),
    identity: await executionIdentity(directory, async () => {
      signal.throwIfAborted();
    }),
    conditions: hostConditions(conditions),
    smoke,
    plan: diagnosticPlan(smoke),
  };
  const save = (name: string, value: unknown) =>
    writeFile(join(directory, name), JSON.stringify(value, null, 2) + "\n");
  await save("manifest.json", manifest);
  const session = await startZooGlassSession({
    configuration: new Workload(baseline).configuration,
    javaOptions,
    signal,
    startupTimeoutMs: 300000,
  });
  let complete = false;
  try {
    if (!session.processId)
      throw new Error("Diagnostic requires an owned prepared JVM");
    for (const [index, trial] of manifest.plan.entries()) {
      session.signal.throwIfAborted();
      await delay(smoke ? 50 : 2000, undefined, { signal: session.signal });
      const sampler = trial.sampled
        ? await startResources(session.processId)
        : undefined;
      const loop = monitorEventLoopDelay({ resolution: 10 });
      loop.enable();
      try {
        const result = await clientDiagnostic(baseline, {
          rate: trial.rate,
          durationMs: trial.durationMs,
          signal: session.signal,
          capture: true,
        });
        loop.disable();
        const eventLoop = {
          samples: loop.count,
          meanMs: loop.count ? loop.mean / 1e6 : null,
          p99Ms: loop.count ? loop.percentile(99) / 1e6 : null,
          maxMs: loop.count ? loop.max / 1e6 : null,
        };
        const resources = sampler ? await sampler.stop() : [];
        session.signal.throwIfAborted();
        await save(`trial-${String(index + 1).padStart(2, "0")}.json`, {
          trial,
          result,
          eventLoop,
          resources,
          limitation:
            "Sampler wall duration is asynchronous, not event-loop blocking time. Event-loop monitoring and timing capture are enabled in both arms. No publications reach the idle JVM.",
        });
      } finally {
        loop.disable();
        await sampler?.stop();
      }
    }
    complete = true;
  } finally {
    await session.close({ requireOrderly: true });
    await save("completion.json", {
      complete,
      endedUtc: new Date().toISOString(),
    });
  }
}
