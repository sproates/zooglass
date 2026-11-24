import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { runDriver } from "../driver.js";
import { classify, measure } from "../metrics.js";
import { startResources, storeSizes } from "../resources.js";
import { clientDiagnostic } from "../diagnostic.js";
import { javaOptions, serviceDirectory } from "./identity.js";
import {
  artifactNames,
  observations,
  writeJson,
  writeObservations,
} from "./evidence.js";
import { nextSlot, resolveRates } from "./plan.js";
import { writeReport } from "./report.js";
import type { CampaignJournal } from "./journal.js";
import {
  startupFailure,
  startupOutcome,
  type AttemptToken,
  type CampaignManifest,
  type Variant,
} from "./model.js";

type Diagnostic = Awaited<ReturnType<typeof clientDiagnostic>>;

export async function executeAttempt(
  token: AttemptToken,
  lockFd: number,
  signal: AbortSignal,
  diagnostic: Diagnostic,
  checkpoint: () => Promise<void>,
) {
  let resources: Awaited<ReturnType<typeof startResources>> | undefined;
  const boundaries: Record<string, unknown> = {};
  const databasePath =
    token.slot.storage === "sqlite"
      ? join(token.directory, "store.sqlite")
      : undefined;
  let result: Awaited<ReturnType<typeof runDriver>>;
  try {
    result = await runDriver({
      workload: token.slot.workload,
      rate: token.rate,
      warmupMs: 30000,
      measurementMs: 120000,
      drainMs: 10000,
      serviceDirectory,
      databasePath,
      javaOptions,
      inheritedLockFd: lockFd,
      signal,
      async onReady(pid) {
        resources = await startResources(pid);
      },
      async onBoundary(phase) {
        boundaries[phase] = {
          atMs: performance.now(),
          files: await storeSizes(databasePath),
        };
      },
    });
  } catch (cause) {
    await resources?.stop();
    await checkpoint();
    const failure = startupFailure(cause);
    await writeJson(join(token.directory, "failure.json"), failure);
    return {
      outcome: startupOutcome(failure),
      reason: failure.error,
      artifacts: await artifactNames(token.directory),
    };
  }
  const samples = (await resources?.stop()) ?? [];
  await checkpoint();
  await writeJson(join(token.directory, "run.json"), result.report);
  await writeObservations(
    join(token.directory, "observations.jsonl"),
    result.observations,
    checkpoint,
  );
  const metrics = await measure(
    result.report,
    observations(join(token.directory, "observations.jsonl"), checkpoint),
  );
  await checkpoint();
  const classification = classify(result.report, metrics, diagnostic.qualified);
  await writeJson(join(token.directory, "metrics.json"), {
    ...metrics,
    classification,
  });
  await writeJson(join(token.directory, "resources.json"), {
    samples,
    boundaries,
    clientDiagnostic: diagnostic,
    stoppedStore: await storeSizes(databasePath),
    sqlite:
      token.slot.storage === "sqlite"
        ? {
            journalMode: "WAL",
            synchronous: "FULL",
            autoCheckpointPages: 1000,
            source:
              "Prepared runtime SqliteConnection configuration; no competing live connection",
          }
        : null,
    limitations: [
      "Best-effort one-second external sampling; sample timestamps and overhead retained",
      "Storage samples identify their start time at each phase boundary; measurement-end precedes drain",
      "No direct thermal or memory-pressure sensor; session conditions are recorded separately",
    ],
  });
  return {
    outcome: classification.outcome,
    reason: classification.reasons.join("; "),
    artifacts: await artifactNames(token.directory),
  };
}

export async function runCampaign(
  journal: CampaignJournal,
  manifest: CampaignManifest,
  lockFd: number,
  maxAttempts: number,
  paused: () => boolean,
) {
  let count = 0,
    reason = "frozen schedule exhausted";
  try {
    // Diagnostics are per-session so a resumed host cannot inherit a stale qualification.
    const diagnostics = new Map<Variant, Diagnostic>();
    while (count < maxAttempts && !paused()) {
      await journal.checkpoint();
      const next = nextSlot(manifest, journal.state, journal.replacements);
      if (!next) break;
      if (next.needsResolution) {
        await journal.saveResolution(resolveRates(manifest, journal.state));
        continue;
      }
      if (journal.remainingMs < manifest.limits.attemptMs + 60000) {
        reason = "insufficient budget for settling and another attempt";
        break;
      }
      if (!diagnostics.size) {
        for (const variant of new Set(
          manifest.slots.map((slot) => slot.variant),
        )) {
          if (paused()) break;
          await journal.checkpoint();
          diagnostics.set(
            variant,
            await clientDiagnostic(
              manifest.slots.find((s) => s.variant === variant)!.workload,
            ),
          );
        }
        await journal.recordDiagnostics(Object.fromEntries(diagnostics));
        if (paused()) break;
      }
      await journal.reserveWait();
      await delay(manifest.limits.settleMs);
      await journal.finishWait();
      if (paused()) break;
      const token = await journal.reserveAttempt(next.slot.id, next.rate);
      await journal.checkpoint();
      // Leave time for owned-service shutdown and sealing within the same reservation.
      const timeout = AbortSignal.timeout(
        Math.max(1, Math.floor(journal.remainingReservationMs - 30_000)),
      );
      const completion = await executeAttempt(
        token,
        lockFd,
        timeout,
        diagnostics.get(token.slot.variant)!,
        () => journal.checkpoint(),
      );
      await journal.finishAttempt(token, completion);
      count++;
    }
    if (paused()) reason = "requested pause after current attempt";
    else if (count >= maxAttempts) reason = "requested attempt count reached";
    await journal.checkpoint();
    await writeReport(
      journal.directory,
      manifest,
      journal.state,
      journal.remainingMs,
      reason,
    );
  } catch (cause) {
    reason = `stopped: ${String(cause)}`;
    throw cause;
  } finally {
    await journal.closeSession(reason);
  }
  return reason;
}
