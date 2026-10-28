import { startZooGlassSession } from "../../../service/zooglass-session.js";
import { startBrowserHttpServer } from "../../../browser/browser-http-server.js";
import { createBrowserDataRoute } from "../../../browser/browser-data-route.js";
import { drivingApplication } from "./application.js";
import { loadCars } from "./journeys.js";
import { startProducer, type ProducerOptions } from "./producer.js";
import type { FleetMapConfiguration } from "../fleet-assets.js";

interface SimulationOptions extends ProducerOptions {
  bindAddress?: string;
  map?: FleetMapConfiguration;
}

/** Composition for the continuous demonstration: service, sources, read-only viewer. */
export async function startSimulation(options: SimulationOptions = {}) {
  const cars = await loadCars();
  const service = await startZooGlassSession({
    views: [
      {
        id: "driving",
        fields: {
          position: [{ sourceId: "fleet", type: "position" }],
          notice: [{ sourceId: "fleet", type: "notice" }],
        },
        ordering: {
          position: { mode: "latestBySequence", sequenceField: "sequence" },
          notice: { mode: "latestBySequence", sequenceField: "sequence" },
        },
      },
    ],
  });
  let http: Awaited<ReturnType<typeof startBrowserHttpServer>> | undefined;
  let producer: Awaited<ReturnType<typeof startProducer>> | undefined;
  const route = createBrowserDataRoute(service.baseUrl, service.signal);
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      await producer?.close();
      try {
        await route.close();
      } finally {
        try {
          await http?.close();
        } finally {
          await service.close();
        }
      }
    })());
  try {
    http = await startBrowserHttpServer(
      await drivingApplication(cars, options.map),
      options.bindAddress,
    );
    const host = http;
    host.server.on("upgrade", (request, socket, head) => {
      if (request.url !== "/views/live" || !host.accepts(request)) {
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        return;
      }
      route.upgrade(request, socket, head);
    });
    producer = await startProducer(service.baseUrl, cars, options);
    return {
      origin: host.origin,
      baseUrl: service.baseUrl,
      cars,
      done: producer.done,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
