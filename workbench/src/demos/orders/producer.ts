import { setTimeout as delay } from "node:timers/promises";
import {
  closeAll,
  closeClient,
  connectClient,
} from "../../execution/sockets.js";
import { publishAndCheckReceipt } from "../../execution/publication-receipt.js";
import { scenarioEpoch } from "../../service/runtime-configuration.js";
import { advanceOrderProgress } from "./progress.js";
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
  const url = new URL("/events", baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const sockets = new Map<OrderSource, WebSocket>();
  let progress: WebSocket | undefined;
  const closeSockets = () =>
    closeAll([...sockets.values(), progress].map(closeClient));

  try {
    const progressUrl = new URL("/progress", url);
    progress = await connectClient(progressUrl.href, signal, false);
    for (const source of sourceIds) {
      sockets.set(source, await connectClient(url.href, signal, false));
    }
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
          if (action.kind === "omit") {
            continue;
          }
          if (action.kind === "watermark") {
            await advanceOrderProgress(progress!, action, signal);
          } else if (action.kind === "disconnect") {
            await closeClient(sockets.get(action.source));
            sockets.delete(action.source);
          } else if (action.kind === "reconnect") {
            sockets.set(
              action.source,
              await connectClient(url.href, signal, false),
            );
          } else {
            const socket = sockets.get(action.event.sourceId);
            if (
              !socket ||
              socket.readyState !== WebSocket.OPEN ||
              socket.bufferedAmount > 65536
            ) {
              throw new Error(
                `Order source ${action.event.sourceId} failed or could not keep up.`,
              );
            }
            const receipt = await publishAndCheckReceipt(
              socket,
              {
                ...action.event,
                epoch: scenarioEpoch,
                publicationSequence: action.event.publicationSequence,
              },
              signal,
            );
            if (
              action.retry &&
              (receipt.status !== "duplicate" ||
                receipt.reason !== "alreadyCommitted")
            ) {
              throw new Error(
                `Expected duplicate/alreadyCommitted for Order retry, received ${receipt.status}/${receipt.reason}.`,
              );
            }
            if (action.unmapped) {
              const targets = receipt.targets;
              if (
                receipt.status !== "committed" ||
                receipt.reason !== "sqlite" ||
                targets?.length !== 1 ||
                targets[0].viewId !== "order-summary" ||
                targets[0].entityId !== null ||
                targets[0].status !== "rejected" ||
                targets[0].reason !== "unknownEntityMapping"
              ) {
                throw new Error(
                  "Expected committed publication with one unmapped summary target.",
                );
              }
            } else if (
              !receipt.targets?.length ||
              receipt.targets.some((target) => target.status !== "accepted")
            ) {
              throw new Error(
                `Unexpected Order target rejection: ${JSON.stringify(receipt.targets)}`,
              );
            }
          }
        }
        await options.onStep?.(step);
        if (
          options.cycles === undefined ||
          tick + 1 < options.cycles * ticksPerCycle
        ) {
          await delay(tickMs, undefined, { signal });
        }
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
