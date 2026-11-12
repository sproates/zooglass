import {
  closeAll,
  closeClient,
  connectClient,
} from "../../execution/sockets.js";
import {
  publishAndCheckReceipt,
  type PublicationReceipt,
} from "../../execution/publication-receipt.js";
import {
  controlExchange,
  type ControlExchange,
} from "../../execution/control-request.js";
import { retireAndCheckReceipt } from "../../execution/fact-retirement.js";
import { factFields, sportsViews } from "./configuration.js";
import { checkSportsReceipt } from "./receipts.js";
import type { SportsStep } from "./timeline.js";

/** Two independent source clients. Controls use bounded request sockets, never capture history. */
export async function openSportsSources(
  baseUrl: string,
  signal: AbortSignal,
  exchange: ControlExchange = controlExchange(baseUrl, signal),
) {
  const url = new URL("/events", baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const sockets = new Map<string, WebSocket>();
  const close = () => closeAll([...sockets.values()].map(closeClient));
  try {
    for (const source of ["match-feed", "bookmaker"])
      sockets.set(source, await connectClient(url.href, signal, false));
  } catch (error) {
    await close();
    throw error;
  }
  return {
    close,
    async execute(step: SportsStep): Promise<PublicationReceipt[]> {
      const receipts: PublicationReceipt[] = [];
      for (const action of step.actions) {
        signal.throwIfAborted();
        switch (action.kind) {
          case "disconnect":
            await closeClient(sockets.get("bookmaker"));
            sockets.delete("bookmaker");
            break;
          case "reconnect":
            if (sockets.has("bookmaker"))
              throw new Error("Bookmaker is already connected.");
            sockets.set(
              "bookmaker",
              await connectClient(url.href, signal, false),
            );
            break;
          case "retire":
            for (const viewId of sportsViews)
              await retireAndCheckReceipt(exchange, {
                viewId,
                entityId: action.entityId,
                fields: factFields(viewId),
                minimumBirthSequence: action.minimumBirthSequence,
              });
            break;
          case "watermark": {
            const control = {
              sourceId: "bookmaker",
              epoch: "run",
              sourceEntityId: action.entityId,
              throughSequence: action.throughSequence,
            };
            const reply = (await exchange("/progress", control)) as {
              kind: string;
              status: string;
              stream: typeof control;
              throughSequence: number;
            };
            if (
              reply.kind !== "watermark" ||
              !["committed", "duplicate"].includes(reply.status) ||
              reply.stream?.sourceId !== control.sourceId ||
              reply.stream?.epoch !== control.epoch ||
              reply.stream?.sourceEntityId !== control.sourceEntityId ||
              reply.throughSequence !== control.throughSequence
            )
              throw new Error(
                "Sports watermark acknowledgement rejected or mismatched.",
              );
            break;
          }
          case "publish": {
            const socket = sockets.get(action.event.sourceId);
            if (
              !socket ||
              socket.readyState !== WebSocket.OPEN ||
              socket.bufferedAmount > 65536
            )
              throw new Error(
                `Sports source ${action.event.sourceId} disconnected or cannot keep up.`,
              );
            const receipt = await publishAndCheckReceipt(
              socket,
              action.event,
              signal,
            );
            checkSportsReceipt(action, receipt);
            receipts.push(receipt);
          }
        }
      }
      return receipts;
    },
  };
}
