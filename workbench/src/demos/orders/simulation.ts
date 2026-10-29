import { startZooGlassSession } from "../../service/zooglass-session.js";
import { orderViews } from "./contracts.js";
import { startOrderProducer, type OrderProducerOptions } from "./producer.js";

/** Service-only composition. Browser and CLI bindings are a subsequent slice. */
export async function startOrderSimulation(options: OrderProducerOptions = {}) {
  const service = await startZooGlassSession({
    views: orderViews,
    signal: options.signal,
  });
  try {
    const producer = await startOrderProducer(service.baseUrl, {
      ...options,
      signal: service.signal,
    });
    return {
      baseUrl: service.baseUrl,
      done: producer.done,
      async close() {
        try {
          await producer.close();
        } finally {
          await service.close();
        }
      },
    };
  } catch (error) {
    await service.close();
    throw error;
  }
}
