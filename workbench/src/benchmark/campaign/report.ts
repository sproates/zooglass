import { writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { json } from "./evidence.js";
import { rates } from "./plan.js";
import type { measure } from "../metrics.js";
import type { CampaignManifest, JournalState } from "./model.js";

/** Derived view only; the verified journal and attempt inventories remain authoritative. */
export async function writeReport(
  directory: string,
  manifest: CampaignManifest,
  state: Readonly<JournalState>,
  remainingMs: number,
  reason: string,
) {
  const lines = [
    "# Single-instance performance campaign",
    "",
    `Campaign: ${manifest.campaignId}`,
    "",
    `Stopped/paused: ${reason}. Remaining active budget: ${(remainingMs / 60000).toFixed(1)} minutes.`,
    "",
    "This report includes every attempt, including failures and interruptions. It is not an independently audited performance claim. Latencies are conditional on completion; inspect each attempt's metrics.json for missing denominators and separate receipt/fan-out backlogs.",
    "",
    "| Slot | Attempt | Session | Rate/s | Outcome | Reason |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  const escape = (value: string) =>
    value.replaceAll("|", "\\|").replaceAll("\n", " ");
  for (const slot of manifest.slots) {
    const attempts = state.attempts.filter((a) => a.slotId === slot.id);
    if (!attempts.length)
      lines.push(
        `| ${slot.id} | none | | | ${slot.variant !== "baseline" && state.resolution?.rates[slot.storage] === null ? "skipped: no qualifying baseline" : "unfinished"} | |`,
      );
    for (const attempt of attempts)
      lines.push(
        `| ${slot.id} | ${attempt.id}${attempt.replaces ? ` replaces ${attempt.replaces}` : ""} | ${attempt.sessionId} | ${attempt.rate} | ${attempt.completion?.outcome ?? attempt.status} | ${escape(attempt.completion?.reason ?? "No valid completion")} |`,
      );
  }
  lines.push(
    "",
    "## Per-attempt measurements",
    "",
    "Percentiles are completed samples only, never averages of percentiles. Missing denominators remain alongside each latency distribution in metrics.json.",
    "",
    "| Attempt | Successful receipts/s in window | Receipt p99 ms | Full fan-out p99 ms | Missing receipt samples | Missing fan-out samples |",
    "| --- | --- | --- | --- | --- | --- |",
  );
  for (const attempt of state.attempts) {
    if (!attempt.completion?.artifacts.some((a) => a.name === "metrics.json"))
      continue;
    const m = (await json(
      join(directory, "attempts", attempt.id, "metrics.json"),
    )) as Awaited<ReturnType<typeof measure>>;
    lines.push(
      `| ${attempt.id} | ${m.achievedPerSecond.toFixed(2)} | ${m.latency.receiptFromPlan.p99?.toFixed(3) ?? "unavailable"} | ${m.latency.fanoutFromPlan.p99?.toFixed(3) ?? "unavailable"} | ${m.latency.receiptFromPlan.missing} | ${m.latency.fanoutFromPlan.missing} |`,
    );
  }
  lines.push("", "## Tested baseline bounds", "");
  for (const storage of ["memory", "sqlite"] as const) {
    const passing = rates.filter((rate) => {
      const slots = manifest.slots.filter(
        (s) => s.storage === storage && s.baselineRate === rate,
      );
      return slots.every(
        (s) =>
          state.attempts.filter((a) => a.slotId === s.id).at(-1)?.completion
            ?.outcome === "pass",
      );
    });
    const failed = state.attempts
      .filter(
        (a) =>
          a.completion &&
          a.completion.outcome !== "pass" &&
          manifest.slots.find((s) => s.id === a.slotId)?.storage === storage &&
          manifest.slots.find((s) => s.id === a.slotId)?.variant === "baseline",
      )
      .sort((a, b) => a.rate - b.rate)[0];
    const highest = passing.at(-1);
    const selected = state.resolution?.rates[storage];
    lines.push(
      `- ${storage}: highest all-three-passing tested rate ${highest ?? "none"}; lowest observed failing rate ${failed ? `${failed.rate} (${failed.completion!.outcome})` : "none"}. Comparison rate ${selected ?? "unresolved or unavailable"}${selected && highest && selected > highest / 2 ? "; no demonstrated headroom" : ""}.`,
    );
  }
  lines.push(
    "",
    "## Sessions",
    "",
    "Session boundaries expose pauses and changing host conditions. The last active session closes in journal.json after this report snapshot is written.",
    "",
  );
  for (const session of state.sessions)
    lines.push(
      `- ${session.id}: ${session.startedUtc} to ${session.endedUtc ?? (session.recoveredUtc ? `end unknown; abandonment discovered ${session.recoveredUtc}` : "active at report snapshot")}; ${escape(session.reason ?? reason)}. ${escape(JSON.stringify(session.conditions))}`,
    );
  lines.push(
    "",
    "## Comparison rates",
    "",
    state.resolution
      ? JSON.stringify(state.resolution.rates)
      : "Pending complete baseline evidence.",
    "",
    "A lowest passing fallback may have no demonstrated headroom. No interpolation or maximum-capacity claim is made. See manifest.json for exact inputs and identity, run.json and metrics.json for each result, and resources.json for sampled processes and unavailable measurements.",
    "",
  );
  await writeFile(join(directory, "report.md.pending"), lines.join("\n"));
  await rename(
    join(directory, "report.md.pending"),
    join(directory, "report.md"),
  );
}
