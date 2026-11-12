import { setTimeout as delay } from "node:timers/promises";
import type { ControlExchange } from "../../execution/control-request.js";
import type { PublicationReceipt } from "../../execution/publication-receipt.js";
import { openSportsSources } from "./source-session.js";
import { sportsTimeline, type SportsStep } from "./timeline.js";

export interface SportsProducerOptions {
  tickMs?: number;
  cycles?: number;
  signal?: AbortSignal;
  /** Awaiting a checkpoint holds the schedule; observers must retain bounded state. */
  onStep?: (
    step: SportsStep,
    receipts: PublicationReceipt[],
  ) => void | Promise<void>;
  /** Control transport also permits deterministic acknowledgement-loss qualification. */
  exchange?: ControlExchange;
}
export async function startSportsProducer(
  baseUrl: string,
  options: SportsProducerOptions = {},
) {
  const tickMs = options.tickMs ?? 3000;
  if (!Number.isFinite(tickMs) || tickMs < 10)
    throw new Error("Sports tick interval must be at least 10ms.");
  if (
    options.cycles !== undefined &&
    (!Number.isSafeInteger(options.cycles) || options.cycles < 1)
  )
    throw new Error("Sports cycle count must be a positive safe integer.");
  const lifetime = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([lifetime.signal, options.signal])
    : lifetime.signal;
  const sources = await openSportsSources(baseUrl, signal, options.exchange);
  const status: {
    state: "running" | "complete" | "failed" | "stopped";
    error?: string;
  } = { state: "running" };
  const done = (async () => {
    try {
      for (const step of sportsTimeline(options.cycles)) {
        signal.throwIfAborted();
        const receipts = await sources.execute(step);
        await options.onStep?.(step, receipts);
        await delay(tickMs, undefined, { signal });
      }
      status.state = "complete";
    } catch (error) {
      status.state = signal.aborted ? "stopped" : "failed";
      status.error = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      await sources.close();
    }
  })();
  void done.catch(() => {});
  let closing: Promise<void> | undefined;
  return {
    done,
    status,
    close() {
      return (closing ??= (async () => {
        lifetime.abort();
        await done.catch(() => {});
      })());
    },
  };
}
