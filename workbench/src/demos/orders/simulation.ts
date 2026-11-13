import { startZooGlassSession } from "../../service/zooglass-session.js";
import { orderConfiguration } from "./configuration.js";
import { startOrderProducer, type OrderProducerOptions } from "./producer.js";

/** Service-only composition for independent source verification. */
export async function startOrderSimulation(options: OrderProducerOptions = {}) {
  const service = await startZooGlassSession({
    configuration: orderConfiguration(),
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
