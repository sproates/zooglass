import { once } from "node:events";
import { scenarioEpoch } from "../../service/runtime-configuration.js";
import type { OrderAction } from "./timeline.js";

export async function advanceOrderProgress(
  socket: WebSocket,
  action: Extract<OrderAction, { kind: "watermark" }>,
  signal: AbortSignal,
) {
  const lifetime = new AbortController();
  const closed = () =>
    lifetime.abort(new Error("Progress socket closed before acknowledgement."));
  socket.addEventListener("close", closed);
  const reply = once(socket, "message", {
    signal: AbortSignal.any([
      signal,
      lifetime.signal,
      AbortSignal.timeout(5000),
    ]),
  });
  try {
    socket.send(
      JSON.stringify({
        sourceId: action.source,
        epoch: scenarioEpoch,
        sourceEntityId: action.entityId,
        throughSequence: action.throughSequence,
      }),
    );
    const [message] = await reply;
    const result = JSON.parse(message.data);
    if (
      result.kind !== "watermark" ||
      !["applied", "committed", "duplicate"].includes(result.status) ||
      result.stream?.sourceId !== action.source ||
      result.stream?.epoch !== scenarioEpoch ||
      result.stream?.sourceEntityId !== action.entityId ||
      result.throughSequence !== action.throughSequence
    ) {
      throw new Error(
        `Order progress rejected or mismatched: ${result.reason ?? result.status}`,
      );
    }
  } finally {
    lifetime.abort();
    socket.removeEventListener("close", closed);
    await reply.catch(() => {});
  }
}
