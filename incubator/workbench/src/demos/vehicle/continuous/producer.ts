import { setTimeout as delay } from "node:timers/promises";
import { connectClient, closeClient } from "../../../execution/sockets.js";
import { journey, type Car } from "./journeys.js";

export interface ProducerOptions {
  tickMs?: number;
}

/** One persistent event source per car, owned by the simulation, never by a viewer. */
export async function startProducer(
  baseUrl: string,
  cars: Car[],
  options: ProducerOptions = {},
) {
  const lifetime = new AbortController();
  const url = new URL("/events", baseUrl);
  url.protocol = "ws:";
  const sockets: WebSocket[] = [];
  try {
    for (const car of cars) {
      void car;
      sockets.push(await connectClient(url.href, lifetime.signal));
    }
  } catch (error) {
    await Promise.allSettled(sockets.map(closeClient));
    throw error;
  }
  const paths = cars.map(journey);
  const done = (async () => {
    let tick = 0;
    while (!lifetime.signal.aborted) {
      for (let i = 0; i < cars.length; i++) {
        const [latitude, longitude] = paths[i].position(tick);
        sockets[i].send(
          JSON.stringify({
            sourceId: "fleet",
            type: "position",
            entityId: cars[i].id,
            payload: {
              sequence: tick + 1,
              latitude,
              longitude,
              observedAt: Date.now(),
            },
          }),
        );
      }
      tick++;
      await delay(options.tickMs ?? 1000, undefined, {
        signal: lifetime.signal,
      });
    }
  })();
  void done.catch(() => {});
  return {
    done,
    async close() {
      lifetime.abort();
      await done.catch(() => {});
      await Promise.allSettled(sockets.map(closeClient));
    },
  };
}
