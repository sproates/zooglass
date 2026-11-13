import { setTimeout as delay } from "node:timers/promises";
import { openOrderSources } from "./source-session.js";
import { orderStep, ticksPerCycle, type OrderStep } from "./timeline.js";

export interface OrderProducerOptions {
  tickMs?: number;
  /** Omit for infinite operation; bounded runs exercise the identical delivery path. */
  cycles?: number;
  signal?: AbortSignal;
  /** A checkpoint observer may await service processing before the next step. */
  onStep?: (step: OrderStep) => void | Promise<void>;
}

/** Owns five source sockets and a progress socket, with an actual inventory outage. */
export async function startOrderProducer(
  baseUrl: string,
  options: OrderProducerOptions = {},
) {
  const tickMs = options.tickMs ?? 3000;
  if (!Number.isFinite(tickMs) || tickMs < 10) {
    throw new Error("Order tick interval must be at least 10ms.");
  }
  if (
    options.cycles !== undefined &&
    (!Number.isSafeInteger(options.cycles) || options.cycles < 1)
  ) {
    throw new Error("Order cycle count must be a positive safe integer.");
  }

  const lifetime = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([lifetime.signal, options.signal])
    : lifetime.signal;
  const sources = await openOrderSources(baseUrl, signal);

  const done = (async () => {
    const epoch = Date.now();
    try {
      for (
        let tick = 0;
        options.cycles === undefined || tick < options.cycles * ticksPerCycle;
        tick++
      ) {
        signal.throwIfAborted();
        const step = orderStep(tick, epoch, tickMs);
        await sources.execute(step);
        await options.onStep?.(step);
        if (
          options.cycles === undefined ||
          tick + 1 < options.cycles * ticksPerCycle
        ) {
          await delay(tickMs, undefined, { signal });
        }
      }
    } finally {
      await sources.close();
    }
  })();
  void done.catch(() => {});

  let closing: Promise<void> | undefined;
  return {
    done,
    close() {
      return (closing ??= (async () => {
        lifetime.abort();
        await done.catch(() => {});
      })());
    },
  };
}
