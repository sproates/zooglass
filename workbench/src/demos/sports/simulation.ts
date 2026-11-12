import { startZooGlassSession } from "../../service/zooglass-session.js";
import { sportsConfiguration } from "./configuration.js";
import { startSportsProducer, type SportsProducerOptions } from "./producer.js";

/** Owns a fresh SQLite service and its sources; no browser or Java build dependency. */
export async function startSportsSimulation(
  options: SportsProducerOptions = {},
) {
  const service = await startZooGlassSession({
    configuration: sportsConfiguration(),
    signal: options.signal,
  });
  try {
    const producer = await startSportsProducer(service.baseUrl, {
      ...options,
      signal: service.signal,
    });
    return {
      baseUrl: service.baseUrl,
      done: producer.done,
      status: producer.status,
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
