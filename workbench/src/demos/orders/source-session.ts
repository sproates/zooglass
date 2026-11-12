import {
  closeAll,
  closeClient,
  connectClient,
} from "../../execution/sockets.js";
import { publishAndCheckReceipt } from "../../execution/publication-receipt.js";
import { scenarioEpoch } from "../../service/runtime-configuration.js";
import { advanceOrderProgress } from "./progress.js";
import { sourceIds, type OrderSource } from "./contracts.js";
import type { OrderStep } from "./timeline.js";

/** Source socket ownership and receipt checks shared by both delivery modes. */
export async function openOrderSources(baseUrl: string, signal: AbortSignal) {
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

  return {
    close: closeSockets,
    async execute(step: OrderStep) {
      signal.throwIfAborted();
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
    },
  };
}
