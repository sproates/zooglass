import { setTimeout as delay } from "node:timers/promises";
import { connectClient, closeClient } from "../../../execution/sockets.js";
import { journey, type Car } from "./journeys.js";
import { deliveryAt, type Delivery } from "./delivery.js";

export interface ProducerOptions {
  tickMs?: number;
}
interface DelayedEvent {
  due: number;
  message: string;
}
interface CarSource {
  socket: WebSocket | undefined;
  previous: Delivery;
  delayed: DelayedEvent | undefined;
}

/** Independent real source sockets; only one delayed event per car is retained. */
export async function startProducer(
  baseUrl: string,
  cars: Car[],
  options: ProducerOptions = {},
) {
  const tickMs = options.tickMs ?? 1000;
  if (!Number.isFinite(tickMs) || tickMs < 10)
    throw new Error("Tick interval must be at least 10ms.");
  const lifetime = new AbortController();
  const url = new URL("/events", baseUrl);
  url.protocol = "ws:";
  const sources: CarSource[] = cars.map(() => ({
    socket: undefined,
    previous: "normal",
    delayed: undefined,
  }));
  const paths = cars.map(journey);

  function send(source: CarSource, message: string) {
    if (
      !source.socket ||
      source.socket.readyState !== WebSocket.OPEN ||
      source.socket.bufferedAmount > 65536
    )
      throw new Error("A car source failed or could not keep up.");
    source.socket.send(message);
  }
  const event = (i: number, type: string, payload: unknown) =>
    JSON.stringify({
      sourceId: "fleet",
      type,
      entityId: cars[i].id,
      payload,
    });
  function notice(i: number, tick: number, text: string) {
    send(
      sources[i],
      event(i, "notice", { sequence: tick + 1, text, at: Date.now() }),
    );
  }

  try {
    for (const source of sources)
      source.socket = await connectClient(url.href, lifetime.signal);
  } catch (error) {
    await Promise.allSettled(
      sources.map((source) => closeClient(source.socket)),
    );
    throw error;
  }
  const done = (async () => {
    let tick = 0;
    while (!lifetime.signal.aborted) {
      for (let i = 0; i < cars.length; i++) {
        const source = sources[i];
        const delivery = deliveryAt(tick, i);
        if (delivery === "offline") {
          if (source.previous !== "offline") {
            notice(i, tick, "source disconnecting for 20 reports");
            await closeClient(source.socket);
            source.socket = undefined;
          }
        } else {
          if (source.previous === "offline") {
            source.socket = await connectClient(url.href, lifetime.signal);
            notice(i, tick, "source reconnected");
          }
          if (source.delayed && source.delayed.due <= tick) {
            send(source, source.delayed.message);
            source.delayed = undefined;
            notice(i, tick, "delayed report sent after newer reports");
          }
          if (delivery === "quiet") {
            if (source.previous !== "quiet")
              notice(i, tick, "stopped reporting; source remains connected");
          } else {
            if (source.previous === "quiet")
              notice(i, tick, "reporting resumed");
            const [latitude, longitude] = paths[i].position(tick);
            const message = event(i, "position", {
              sequence: tick + 1,
              latitude,
              longitude,
              observedAt: Date.now(),
            });
            if (delivery === "delayed")
              source.delayed = { due: tick + 5, message };
            else if (delivery === "lost")
              notice(i, tick, "one report permanently lost");
            else {
              send(source, message);
              if (delivery === "duplicate") {
                send(source, message);
                notice(i, tick, "duplicate report sent");
              }
            }
          }
        }
        source.previous = delivery;
      }
      tick++;
      await delay(tickMs, undefined, { signal: lifetime.signal });
    }
  })();
  void done.catch(() => {});
  return {
    done,
    async close() {
      lifetime.abort();
      await done.catch(() => {});
      await Promise.allSettled(
        sources.map((source) => closeClient(source.socket)),
      );
    },
  };
}
