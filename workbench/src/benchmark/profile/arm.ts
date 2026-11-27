import { join } from "node:path";
import { runDriver, type DriverOptions } from "../driver.js";
import { startResources, storeSizes } from "../resources.js";
import { writeJson, writeObservations } from "../campaign/evidence.js";
import type { DriverReport } from "../metrics.js";

interface Anchor {
  wallMs: number;
  monotonicMs: number;
  uncertaintyMs: number;
}
function clockAnchor(): Anchor {
  const before = performance.now();
  const wallMs = Date.now();
  const after = performance.now();
  return {
    wallMs,
    monotonicMs: (before + after) / 2,
    uncertaintyMs: after - before + 1,
  };
}

/** A wide/shifted anchor cannot support a precise comparison with JFR's clock. */
export function epochOffset(anchors: Anchor[]) {
  if (
    anchors.length < 3 ||
    anchors.some(
      (a) =>
        !Number.isFinite(a.wallMs) ||
        !Number.isFinite(a.monotonicMs) ||
        !Number.isFinite(a.uncertaintyMs) ||
        a.uncertaintyMs < 0 ||
        a.uncertaintyMs > 5,
    )
  )
    throw new Error("Incomplete or uncertain profile clock anchors");
  const offsets = anchors.map((a) => a.wallMs - a.monotonicMs);
  if (
    offsets.some((n) => !Number.isFinite(n)) ||
    Math.max(...offsets) - Math.min(...offsets) > 5
  )
    throw new Error("Wall clock changed during profile");
  return offsets.reduce((a, b) => a + b, 0) / offsets.length;
}

/** A scheduled window exists even if the driver failed during warm-up. */
export function measurementStart(
  report: Pick<
    DriverReport,
    "errorKind" | "cleanupError" | "error" | "windows"
  > & {
    accounting: Pick<DriverReport["accounting"], "faults">;
  },
  observedMeasurementStart: boolean,
) {
  const measurement = report.windows.find((w) => w.phase === "measurement");
  if (
    report.errorKind === "correctness" ||
    report.cleanupError ||
    Object.keys(report.accounting.faults).length
  ) {
    throw new Error(
      "Driver correctness or cleanup failure: " +
        (report.error ?? "oracle fault"),
    );
  }
  if (measurement?.startMs == null || !observedMeasurementStart)
    throw new Error("Attempt did not reach measurement; raw failure retained");
  return measurement.startMs;
}

/** Close the sampler and retain the driver's raw evidence before inspecting failure or cancellation. */
export async function captureArm(target: string, driverOptions: DriverOptions) {
  const anchors: Anchor[] = [];
  const boundaries: Record<string, unknown> = {};
  let resources: Awaited<ReturnType<typeof startResources>> | undefined;
  let samples: unknown[] = [];
  let resourceError: string | undefined;
  let result: Awaited<ReturnType<typeof runDriver>>;
  try {
    result = await runDriver({
      ...driverOptions,
      async onReady(pid) {
        anchors.push(clockAnchor());
        resources = await startResources(pid);
      },
      async onBoundary(phase) {
        anchors.push(clockAnchor());
        boundaries[phase] = {
          anchor: anchors.at(-1),
          files: await storeSizes(join(target, "store.sqlite")),
        };
      },
    });
  } catch (cause) {
    await writeJson(join(target, "failure.json"), { error: String(cause) });
    throw cause;
  } finally {
    anchors.push(clockAnchor());
    try {
      samples = (await resources?.stop()) ?? [];
    } catch (cause) {
      resourceError = String(cause);
    } finally {
      await writeJson(join(target, "resources.json"), {
        samples,
        anchors,
        boundaries,
        resourceError,
      });
    }
  }
  // Preserve returned driver evidence even after an attempt timeout/cancellation.
  await writeJson(join(target, "run.json"), result.report);
  await writeObservations(
    join(target, "observations.jsonl"),
    result.observations,
  );
  driverOptions.signal?.throwIfAborted();
  if (resourceError) throw new Error(resourceError);
  return {
    report: result.report,
    anchors,
    measurementStartMs: measurementStart(
      result.report,
      Object.hasOwn(boundaries, "measurement-start"),
    ),
  };
}
