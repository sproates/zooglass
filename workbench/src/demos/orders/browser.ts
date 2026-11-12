import { startZooGlassSession } from "../../service/zooglass-session.js";
import { startBrowserHttpServer } from "../../browser/browser-http-server.js";
import { createBrowserDataRoute } from "../../browser/browser-data-route.js";
import { orderConfiguration } from "./configuration.js";
import { describeOrderStep } from "./notices.js";
import { orderApplication } from "./application.js";
import { startOrderProducer, type OrderProducerOptions } from "./producer.js";

interface OrderBrowserOptions extends OrderProducerOptions {
  bindAddress?: string;
}

/** Run-owned service and sources; viewer connections never own the simulation. */
export async function startOrderBrowser(options: OrderBrowserOptions = {}) {
  const lifetime = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, lifetime.signal])
    : lifetime.signal;
  const application = await orderApplication();
  const assets = new Map(application.assets);
  const notices: { tick: number; text: string }[] = [];
  const updateNotices = () =>
    assets.set("/activity.json", [
      "application/json",
      Buffer.from(JSON.stringify(notices)),
    ]);
  updateNotices();
  const service = await startZooGlassSession({
    configuration: orderConfiguration(),
    signal,
  });
  const route = createBrowserDataRoute(service.baseUrl, service.signal);
  let host: Awaited<ReturnType<typeof startBrowserHttpServer>> | undefined;
  let producer: Awaited<ReturnType<typeof startOrderProducer>> | undefined;
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      lifetime.abort();
      try {
        await producer?.close();
      } finally {
        try {
          await route.close();
        } finally {
          try {
            await host?.close();
          } finally {
            await service.close();
          }
        }
      }
    })());
  try {
    host = await startBrowserHttpServer(
      { ...application, assets },
      options.bindAddress,
    );
    const http = host;
    http.server.on("error", (error) => lifetime.abort(error));
    http.server.on("upgrade", (request, socket, head) => {
      if (request.url !== "/views/live" || !http.accepts(request)) {
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        return;
      }
      route.upgrade(request, socket, head);
    });
    producer = await startOrderProducer(service.baseUrl, {
      ...options,
      signal: service.signal,
      async onStep(step) {
        notices.push({ tick: step.tick, text: describeOrderStep(step) });
        if (notices.length > 20) notices.shift();
        updateNotices();
        await options.onStep?.(step);
      },
    });
    return {
      origin: http.origin,
      baseUrl: service.baseUrl,
      done: producer.done,
      close,
      /** Test/operator fault control, never exposed through the public page. */
      setDataBlocked: route.setBlocked,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
