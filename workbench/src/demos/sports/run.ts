import {
  startZooGlassSession,
  type ZooGlassSession,
} from "../../service/zooglass-session.js";
import { createBrowserDataRoute } from "../../browser/browser-data-route.js";
import type { ControlExchange } from "../../execution/control-request.js";
import { sportsConfiguration } from "./configuration.js";
import { openSportsSources } from "./source-session.js";
import { sportsTimeline, type SportsStep } from "./timeline.js";

export interface SportsRunOptions {
  signal: AbortSignal;
  route(route: ReturnType<typeof createBrowserDataRoute> | undefined): void;
  notice(step: SportsStep): void;
  onStep?: (step: SportsStep, signal: AbortSignal) => void | Promise<void>;
  onService?: (service: ZooGlassSession) => void;
  exchange?: ControlExchange;
}

/** Each Reset owns a new service/store and the same source schedule as continuous mode. */
export async function openSportsRun(options: SportsRunOptions) {
  const service = await startZooGlassSession({
    configuration: sportsConfiguration(),
    signal: options.signal,
  });
  let sources: Awaited<ReturnType<typeof openSportsSources>> | undefined;
  let route: ReturnType<typeof createBrowserDataRoute> | undefined;
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      options.route(undefined);
      try {
        await route?.close();
      } finally {
        try {
          await sources?.close();
        } finally {
          await service.close();
        }
      }
    })());
  try {
    sources = await openSportsSources(
      service.baseUrl,
      service.signal,
      options.exchange,
    );
    route = createBrowserDataRoute(service.baseUrl, service.signal);
    options.route(route);
    options.onService?.(service);
  } catch (error) {
    await close();
    throw error;
  }
  const timeline = sportsTimeline(2);
  return {
    signal: service.signal,
    baseUrl: service.baseUrl,
    close,
    async advance(cycle: number, entityId: string, name: string) {
      for (;;) {
        const next = timeline.next();
        if (next.done) break;
        const step = next.value;
        service.signal.throwIfAborted();
        await sources!.execute(step);
        options.notice(step);
        await options.onStep?.(step, service.signal);
        if (
          step.cycle === cycle &&
          step.entityId === entityId &&
          step.name === name
        )
          return;
      }
      throw new Error(
        `Sports checkpoint not found: ${cycle}/${entityId}/${name}`,
      );
    },
  };
}
