import type { Observation } from "./model.js";
import type { runDriver } from "./driver.js";

export type DriverReport = Awaited<ReturnType<typeof runDriver>>["report"];

/** Exact nearest-rank percentiles, conditional on the samples that completed. */
export function distribution(values: number[], expected: number) {
  if (
    values.some((v) => !Number.isFinite(v) || v < 0) ||
    expected < values.length
  )
    throw new Error("Invalid latency samples or denominator");
  values.sort((a, b) => a - b);
  const percentile = (p: number) =>
    values.length ? values[Math.ceil(p * values.length) - 1] : null;
  return {
    samples: values.length,
    missing: expected - values.length,
    conditionalOnCompletion: true,
    sparseTail: values.length < 1000,
    method: "exact-nearest-rank",
    precision: "unrounded monotonic milliseconds",
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
    max: values.at(-1) ?? null,
  };
}

export function slope(
  points: { second: number; value: number }[],
): number | null {
  if (points.length < 2) return null;
  const x = points.reduce((n, p) => n + p.second, 0) / points.length;
  const y = points.reduce((n, p) => n + p.value, 0) / points.length;
  const denominator = points.reduce((n, p) => n + (p.second - x) ** 2, 0);
  return denominator
    ? points.reduce((n, p) => n + (p.second - x) * (p.value - y), 0) /
        denominator
    : null;
}

interface Publication {
  submitted: number;
  planned: number;
  receipt?: number;
  updates: Map<string, number>;
}

/** Offline reduction keeps sorting and reporting out of callback hot paths. */
export async function measure(
  report: DriverReport,
  observations: Iterable<Observation> | AsyncIterable<Observation>,
) {
  const window = report.windows.find((w) => w.phase === "measurement")!;
  const publications = new Map<string, Publication>();
  const expectedLanes =
    report.options.workload.views * report.options.workload.viewers;
  let faults = 0,
    entries = 0,
    lateSubmissions = 0;
  const phaseCounts = Object.fromEntries(
    ["seed", "warmup", "measurement"].map((phase) => [
      phase,
      { submit: 0, receipt: 0, update: 0 },
    ]),
  );
  for await (const observation of observations) {
    entries++;
    if (!["submit", "receipt", "update", "fault"].includes(observation.kind))
      throw new Error("Invalid observation kind");
    if (!Number.isFinite(observation.atMs))
      throw new Error("Invalid observation time");
    if (observation.kind === "fault") {
      faults++;
      continue;
    }
    if (
      !observation.phase ||
      !phaseCounts[observation.phase] ||
      !/^entity-\d+$/.test(observation.entityId ?? "") ||
      !Number.isSafeInteger(observation.sequence) ||
      observation.sequence! < 1
    )
      throw new Error("Invalid observation identity");
    phaseCounts[observation.phase][observation.kind]++;
    if (
      observation.kind === "update" &&
      (!Array.from(
        { length: report.options.workload.viewers },
        (_, i) => `viewer-${i}`,
      ).includes(observation.viewerId!) ||
        !Array.from(
          { length: report.options.workload.views },
          (_, i) => `view-${i}`,
        ).includes(observation.viewId!))
    )
      throw new Error("Invalid delivery lane");
    if (observation.kind === "submit" && observation.phase !== "seed") {
      const phaseWindow = report.windows.find(
        (w) => w.phase === observation.phase,
      );
      if (
        !phaseWindow ||
        observation.plannedMs === undefined ||
        phaseWindow.endMs === null
      )
        throw new Error("Missing submission phase window");
      const delay = observation.atMs - observation.plannedMs;
      if (
        delay > 10 ||
        delay >= 1000 / report.options.rate ||
        observation.atMs >= phaseWindow.endMs
      )
        lateSubmissions++;
    }
    if (observation.phase !== "measurement") continue;
    const key = `${observation.entityId}:${observation.sequence}`;
    if (observation.kind === "submit") {
      if (publications.has(key) || !Number.isFinite(observation.plannedMs))
        throw new Error("Invalid or duplicate submission");
      publications.set(key, {
        submitted: observation.atMs,
        planned: observation.plannedMs!,
        updates: new Map(),
      });
      continue;
    }
    const publication = publications.get(key);
    if (!publication || observation.atMs < publication.submitted)
      throw new Error("Observation has no earlier submission");
    if (observation.kind === "receipt") {
      if (publication.receipt !== undefined)
        throw new Error("Duplicate receipt evidence");
      publication.receipt = observation.atMs;
    } else {
      const lane = `${observation.viewerId}/${observation.viewId}`;
      if (publication.updates.has(lane))
        throw new Error("Duplicate delivery evidence");
      publication.updates.set(lane, observation.atMs);
    }
  }
  if (entries !== report.accounting.rawEntries)
    throw new Error("Raw entry accounting differs");
  for (const phase of ["seed", "warmup", "measurement"] as const) {
    const counts = phaseCounts[phase],
      accounted = report.accounting.phases[phase];
    if (
      counts.submit !== accounted.submitted ||
      counts.receipt !== accounted.acknowledged ||
      counts.update !== accounted.validUpdates ||
      accounted.expectedUpdates !==
        accounted.submitted * (phase === "seed" ? 0 : expectedLanes) ||
      accounted.missingReceipts !==
        accounted.submitted - accounted.acknowledged ||
      accounted.missingUpdates !==
        accounted.expectedUpdates - accounted.validUpdates ||
      accounted.pendingFanout !==
        accounted.submitted - accounted.completedFanout
    )
      throw new Error("Raw phase accounting differs");
  }
  const cohort = report.accounting.phases.measurement;
  const all = [...publications.values()];
  if (
    window.notOffered + all.length !== window.planned ||
    window.missed > window.notOffered ||
    window.missed < 0
  )
    throw new Error("Schedule denominators do not reproduce");
  if (
    all.some(
      (p) =>
        window.startMs === null ||
        window.endMs === null ||
        p.planned < window.startMs ||
        p.planned >= window.endMs ||
        p.submitted < p.planned,
    )
  )
    throw new Error("Submission lies outside its planned measurement window");
  const receipts = all.filter((p) => p.receipt !== undefined);
  const updates = all.flatMap((p) =>
    [...p.updates.values()].map((at) => ({ p, at })),
  );
  const complete = all
    .filter((p) => p.updates.size === expectedLanes)
    .map((p) => ({ p, at: Math.max(...p.updates.values()) }));
  if (
    all.length !== cohort.submitted ||
    receipts.length !== cohort.acknowledged ||
    updates.length !== cohort.validUpdates ||
    complete.length !== cohort.completedFanout ||
    faults !==
      Object.entries(report.accounting.faults)
        .filter(([name]) => name !== "mismatched-snapshot")
        .reduce((n, [, count]) => n + count, 0)
  )
    throw new Error("Raw evidence does not match driver accounting");
  const start = window.startMs,
    end = window.endMs;
  const duration = report.options.measurementMs;
  const buckets = Array.from(
    { length: Math.ceil(duration / 1000) },
    (_, index) => {
      const second = index + 1;
      const boundary =
        start === null ? null : Math.min(start + second * 1000, end!);
      const previous = start === null ? null : start + index * 1000;
      const offered =
        boundary === null ? [] : all.filter((p) => p.submitted < boundary);
      const acknowledged =
        boundary === null
          ? 0
          : receipts.filter((p) => p.receipt! < boundary).length;
      const delivered =
        boundary === null ? 0 : complete.filter((p) => p.at < boundary).length;
      return {
        second,
        planned: Math.min(
          window.planned,
          Math.ceil(second * report.options.rate),
        ),
        submitted: offered.length,
        acknowledged,
        delivered,
        receiptBacklog: offered.length - acknowledged,
        fanoutBacklog: offered.length - delivered,
        receiptCompletions:
          boundary === null
            ? 0
            : receipts.filter(
                (p) => p.receipt! >= previous! && p.receipt! < boundary,
              ).length,
      };
    },
  );
  const inWindow =
    end === null ? 0 : receipts.filter((p) => p.receipt! < end).length;
  return {
    lateSubmissions,
    planned: window.planned,
    submitted: all.length,
    notOffered: window.notOffered,
    missedSlots: window.missed,
    inWindowReceipts: inWindow,
    drainReceipts: receipts.length - inWindow,
    achievedPerSecond: (inWindow * 1000) / duration,
    buckets,
    receiptBacklogSlope: slope(
      buckets
        .slice(-60)
        .map((b) => ({ second: b.second, value: b.receiptBacklog })),
    ),
    fanoutBacklogSlope: slope(
      buckets
        .slice(-60)
        .map((b) => ({ second: b.second, value: b.fanoutBacklog })),
    ),
    latency: {
      scheduler: distribution(
        all.map((p) => p.submitted - p.planned),
        window.planned,
      ),
      receiptFromSubmit: distribution(
        receipts.map((p) => p.receipt! - p.submitted),
        window.planned,
      ),
      receiptFromPlan: distribution(
        receipts.map((p) => p.receipt! - p.planned),
        window.planned,
      ),
      updateFromSubmit: distribution(
        updates.map(({ p, at }) => at - p.submitted),
        window.planned * expectedLanes,
      ),
      updateFromPlan: distribution(
        updates.map(({ p, at }) => at - p.planned),
        window.planned * expectedLanes,
      ),
      fanoutFromPlan: distribution(
        complete.map(({ p, at }) => at - p.planned),
        window.planned,
      ),
    },
  };
}

export function classify(
  report: DriverReport,
  metrics: Awaited<ReturnType<typeof measure>>,
  clientQualified = true,
) {
  const reasons: string[] = [];
  if (
    report.errorKind === "harness-limited" &&
    !Object.keys(report.accounting.faults).length
  )
    return {
      outcome: "harness-limited" as const,
      reasons: [report.error ?? "Harness bound reached"],
    };
  if (
    Object.keys(report.accounting.faults).length ||
    (!report.error &&
      report.finalSnapshots !==
        report.options.workload.hotEntities * report.options.workload.views)
  )
    reasons.push(
      "Independent receipt, delivery or terminal state checks failed",
    );
  if (report.error && report.errorKind === "correctness")
    reasons.push(report.error);
  if (reasons.length) return { outcome: "correctness" as const, reasons };
  if (!clientQualified && report.options.rate === 1000)
    return {
      outcome: "harness-limited" as const,
      reasons: ["The session client-only diagnostic did not qualify 1000/s"],
    };
  if (
    metrics.lateSubmissions ||
    metrics.notOffered ||
    report.windows.some((w) => w.missed || w.notOffered)
  )
    return {
      outcome: "harness-limited" as const,
      reasons: [
        report.error ??
          "The generator missed a planned slot or submitted after its eligible send window",
      ],
    };
  if (report.error) reasons.push(report.error);
  const cohort = report.accounting.phases.measurement;
  if (cohort.missingReceipts || cohort.missingUpdates)
    reasons.push("Measurement obligations did not drain");
  if (metrics.achievedPerSecond < 0.99 * report.options.rate)
    reasons.push(
      "Fewer than 99% of offered receipts completed inside measurement",
    );
  if (
    metrics.latency.receiptFromPlan.samples < 1000 ||
    metrics.latency.fanoutFromPlan.samples < 1000
  )
    reasons.push("Fewer than 1000 completed publication samples");
  if ((metrics.latency.receiptFromPlan.p99 ?? Infinity) > 100)
    reasons.push("Receipt p99 exceeds 100 ms");
  if ((metrics.latency.fanoutFromPlan.p99 ?? Infinity) > 250)
    reasons.push("Complete fan-out p99 exceeds 250 ms");
  if (
    metrics.buckets.length < 60 ||
    metrics.receiptBacklogSlope === null ||
    metrics.fanoutBacklogSlope === null ||
    metrics.receiptBacklogSlope > 0.01 * report.options.rate ||
    metrics.fanoutBacklogSlope > 0.01 * report.options.rate
  )
    reasons.push("Backlog slope budget is not established");
  return {
    outcome: reasons.length ? ("service-budget" as const) : ("pass" as const),
    reasons,
  };
}
