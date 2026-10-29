import { setTimeout as delay } from "node:timers/promises";
import {
  closeAll,
  closeClient,
  connectClient,
} from "../../execution/sockets.js";
import { sourceIds, type OrderSource } from "./contracts.js";
import { orderStep, ticksPerCycle, type OrderStep } from "./timeline.js";

export interface OrderProducerOptions {
  tickMs?: number;
  /** Omit for infinite operation; bounded runs exercise the identical delivery path. */
  cycles?: number;
  signal?: AbortSignal;
  /** A checkpoint observer may await service processing before the next step. */
  onStep?: (step: OrderStep) => void | Promise<void>;
}

/** Owns exactly three source connections, with an actual inventory socket outage. */
export async function startOrderProducer(
  baseUrl: string,
  options: OrderProducerOptions = {},
) {
  const tickMs = options.tickMs ?? 3000;
  if (!Number.isFinite(tickMs) || tickMs < 10)
    throw new Error("Order tick interval must be at least 10ms.");
  if (
    options.cycles !== undefined &&
    (!Number.isSafeInteger(options.cycles) || options.cycles < 1)
  )
    throw new Error("Order cycle count must be a positive safe integer.");

  const lifetime = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([lifetime.signal, options.signal])
    : lifetime.signal;
  const url = new URL("/events", baseUrl);
  url.protocol = "ws:";
  const sockets = new Map<OrderSource, WebSocket>();
  const closeSockets = () => closeAll([...sockets.values()].map(closeClient));

  try {
    for (const source of sourceIds)
      sockets.set(source, await connectClient(url.href, signal));
  } catch (error) {
    await closeSockets();
    throw error;
  }

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
        for (const action of step.actions) {
          if (action.kind === "omit") continue;
          if (action.kind === "disconnect") {
            await closeClient(sockets.get(action.source));
            sockets.delete(action.source);
          } else if (action.kind === "reconnect") {
            sockets.set(action.source, await connectClient(url.href, signal));
          } else {
            const socket = sockets.get(action.event.sourceId);
            if (
              !socket ||
              socket.readyState !== WebSocket.OPEN ||
              socket.bufferedAmount > 65536
            )
              throw new Error(
                `Order source ${action.event.sourceId} failed or could not keep up.`,
              );
            socket.send(JSON.stringify(action.event));
          }
        }
        await options.onStep?.(step);
        if (
          options.cycles === undefined ||
          tick + 1 < options.cycles * ticksPerCycle
        )
          await delay(tickMs, undefined, { signal });
      }
    } finally {
      await closeSockets();
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
