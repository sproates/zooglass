import { startZooGlassSession } from "../../service/zooglass-session.js";
import { startBrowserHttpServer } from "../../browser/browser-http-server.js";
import { createBrowserDataRoute } from "../../browser/browser-data-route.js";
import { sportsConfiguration } from "./configuration.js";
import { describeSportsStep } from "./notices.js";
import { sportsApplication } from "./application.js";
import { startSportsProducer, type SportsProducerOptions } from "./producer.js";

interface SportsBrowserOptions extends SportsProducerOptions {
  bindAddress?: string;
}

/** Run-owned service and sources; viewer connections never own the simulation. */
export async function startSportsBrowser(options: SportsBrowserOptions = {}) {
  const lifetime = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, lifetime.signal])
    : lifetime.signal;
  const application = await sportsApplication();
  const assets = new Map(application.assets);
  const notices: { text: string }[] = [];
  let state = "running";
  let error: string | undefined;
  const updateNotices = () =>
    assets.set("/activity.json", [
      "application/json",
      Buffer.from(JSON.stringify({ state, error, notices })),
    ]);
  updateNotices();
  const service = await startZooGlassSession({
    configuration: sportsConfiguration(),
    signal,
  });
  const route = createBrowserDataRoute(service.baseUrl, service.signal);
  let host: Awaited<ReturnType<typeof startBrowserHttpServer>> | undefined;
  let producer: Awaited<ReturnType<typeof startSportsProducer>> | undefined;
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
    producer = await startSportsProducer(service.baseUrl, {
      ...options,
      signal: service.signal,
      async onStep(step, receipts) {
        notices.push({ text: describeSportsStep(step) });
        if (notices.length > 20) notices.shift();
        updateNotices();
        await options.onStep?.(step, receipts);
      },
    });
    const done = producer.done.then(
      () => {
        state = "complete";
        updateNotices();
      },
      (cause) => {
        state = signal.aborted ? "stopped" : "failed";
        error = cause instanceof Error ? cause.message : String(cause);
        updateNotices();
        throw cause;
      },
    );
    void done.catch(() => {});
    return {
      origin: http.origin,
      baseUrl: service.baseUrl,
      done,
      close,
      /** Test/operator fault control, never exposed through the public page. */
      setDataBlocked: route.setBlocked,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
