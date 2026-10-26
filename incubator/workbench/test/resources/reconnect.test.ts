import assert from "node:assert/strict";
import { getEventListeners, once } from "node:events";
import test from "node:test";
import { startZooGlassSession } from "../../src/service/zooglass-session.js";
import {
  connectClient,
  closeClient,
  messagesBySocket,
} from "../../src/execution/sockets.js";
import {
  liveClient,
  positionEvent,
  type Message,
} from "../support/live-client.js";

async function next(socket: WebSocket): Promise<Message> {
  const inbox = messagesBySocket.get(socket)!;

  if (!inbox.length)
    await once(socket, "message", { signal: AbortSignal.timeout(5000) });

  assert.ok(inbox.length, "expected a socket receipt");

  return inbox.shift() as Message;
}

test(
  "50 reconnects with bounded bursts release caller listeners and consume receipt buffers",
  { timeout: 90_000 },
  async () => {
    const service = await startZooGlassSession({
      views: [
        {
          id: "position",
          fields: { position: [{ sourceId: "feed", type: "position" }] },
          ordering: {
            position: { mode: "latestBySequence", sequenceField: "sequence" },
          },
        },
      ],
    });
    const lifetime = new AbortController();
    let source: Awaited<ReturnType<typeof liveClient>> | undefined;
    let socket: WebSocket | undefined;

    try {
      source = await liveClient(service.baseUrl, "/events");
      for (let cycle = 0; cycle < 50; cycle++) {
        socket = await connectClient(
          service.baseUrl.replace("http:", "ws:") + "/views/live",
          lifetime.signal,
        );

        assert.equal(getEventListeners(lifetime.signal, "abort").length, 0);
        socket.send(
          JSON.stringify({
            action: "subscribe",
            viewId: "position",
            entityId: "bus",
          }),
        );

        assert.equal((await next(socket)).type, "subscribed");

        if (cycle)
          assert.equal(
            (await next(socket)).data?.position.sequence,
            cycle * 25,
          );

        for (let offset = 1; offset <= 25; offset++)
          await source.send(positionEvent("bus", cycle * 25 + offset));
        for (let offset = 1; offset <= 25; offset++)
          assert.equal(
            (await next(socket)).data?.position.sequence,
            cycle * 25 + offset,
          );

        assert.equal(messagesBySocket.get(socket)!.length, 0);
        await closeClient(socket);

        assert.equal(socket.readyState, WebSocket.CLOSED);
        assert.equal(getEventListeners(lifetime.signal, "abort").length, 0);
      }
    } finally {
      try {
        await closeClient(socket);
        await source?.close();
      } finally {
        await service.close();
      }
    }

    await assert.rejects(
      fetch(service.baseUrl + "/actuator/health", {
        signal: AbortSignal.timeout(1000),
      }),
    );
  },
);
