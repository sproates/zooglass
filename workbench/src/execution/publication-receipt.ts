import { once } from "node:events";
export interface PublicationReceipt {
  status: "applied" | "committed" | "duplicate" | "rejected" | "failed";
  reason: string;
  stream: { sourceId: string; epoch: string; sourceEntityId: string };
  publicationSequence: number;
  version: number | null;
  targets?:
    | {
        viewId: string;
        entityId: string | null;
        status: string;
        reason: string | null;
      }[]
    | null;
}

export interface SourcePublication {
  sourceId: string;
  epoch: string;
  entityId: string;
  publicationSequence: number;
  type: string;
  payload: object;
  expectedRejection?: string;
}

export async function publishAndCheckReceipt(
  socket: WebSocket,
  event: SourcePublication,
  signal: AbortSignal,
) {
  const controller = new AbortController();
  const close = () =>
    controller.abort(new Error("Source disconnected before acknowledgement."));
  socket.addEventListener("close", close);
  const waitSignal = AbortSignal.any([
    signal,
    controller.signal,
    AbortSignal.timeout(5000),
  ]);
  const receipt = once(socket, "message", { signal: waitSignal });
  try {
    socket.send(
      JSON.stringify({
        sourceId: event.sourceId,
        epoch: event.epoch,
        sourceEntityId: event.entityId,
        publicationSequence: event.publicationSequence,
        type: event.type,
        payload: event.payload,
      }),
    );
    const [message] = await receipt;
    const result = JSON.parse(message.data) as PublicationReceipt;
    if (
      result.stream?.sourceId !== event.sourceId ||
      result.stream?.epoch !== event.epoch ||
      result.stream?.sourceEntityId !== event.entityId ||
      result.publicationSequence !== event.publicationSequence
    ) {
      throw new Error("Source received a receipt for a different publication.");
    }
    const accepted = ["applied", "committed", "duplicate"].includes(
      result.status,
    );
    if (
      event.expectedRejection !== undefined
        ? result.status !== "rejected" ||
          result.reason !== event.expectedRejection
        : !accepted
    ) {
      throw new Error(
        `Publication ${event.sourceId}/${event.entityId} #${event.publicationSequence}: expected ${event.expectedRejection ?? "acceptance"}, received ${result.status} (${result.reason}).`,
      );
    }
    return result;
  } finally {
    controller.abort();
    socket.removeEventListener("close", close);
    await receipt.catch(() => {});
  }
}
