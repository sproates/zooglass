import { observeVehicleSession } from "./vehicle-observer.js";
import {
  createDemoController,
  DemoCleanupError,
  type DemoRun,
} from "./demo-controller.js";
import { startZooGlassSession } from "./zooglass-session.js";
import { startBrowserSession } from "./browser-session.js";
import { openScenarioSession } from "./scenario-session.js";
import type { TraceEntry } from "./playback.js";
import type { Scenario } from "./scenario.js";

export function createVehicleDemo(
  scenario: Scenario,
  options: { headless?: boolean } = {},
) {
  let browser: Awaited<ReturnType<typeof startBrowserSession>> | undefined;
  let baseUrl: string | undefined;
  const controller = createDemoController(
    scenario,
    async (signal): Promise<DemoRun> => {
      let service: Awaited<ReturnType<typeof startZooGlassSession>> | undefined;
      let ownedBrowser:
        Awaited<ReturnType<typeof startBrowserSession>> | undefined;
      let session: Awaited<ReturnType<typeof openScenarioSession>> | undefined;
      let closing: Promise<void> | undefined;
      const close = () =>
        (closing ??= (async () => {
          const errors: unknown[] = [];
          // Always attempt all owned cleanup, but do not replace a run after any failure.
          for (const resource of [session, ownedBrowser, service]) {
            try {
              await resource?.close();
            } catch (error) {
              errors.push(error);
            }
          }
          if (errors.length)
            throw new DemoCleanupError("Could not close the demo session.", {
              cause: new AggregateError(errors),
            });
        })());
      try {
        service = await startZooGlassSession({ views: scenario.views, signal });
        baseUrl = service.baseUrl;
        ownedBrowser = await startBrowserSession(service.baseUrl, {
          signal: service.signal,
          headless: options.headless,
          keepOpenOnFailure: true,
          onControl: async (action, runId) => {
            if (browser?.host.runId !== runId)
              throw new Error("This run has been replaced.");
            if (action === "disconnect" || action === "reconnect")
              await viewer(action);
            else await controller[action]();
          },
        });
        browser = ownedBrowser;
        session = await openScenarioSession(scenario, service.baseUrl, {
          signal: ownedBrowser.signal,
          createClientExecutor: (client) => {
            if (client.id !== ownedBrowser!.host.clientId)
              throw new Error("Unbound browser client.");
            return ownedBrowser!.host.executor;
          },
        });
        console.log(`Browser host ready at ${ownedBrowser.host.origin}`);
        return {
          signal: ownedBrowser.signal,
          execute: observeVehicleSession(
            session,
            ownedBrowser.page,
            ownedBrowser.signal,
          ).execute,
          close,
          publish: ownedBrowser.host.publish,
        };
      } catch (error) {
        await close();
        throw error;
      }
    },
  );
  const viewer = (action: "disconnect" | "reconnect") => {
    const client = scenario.clients.find((item) => item.id === "rider-app");
    if (!client)
      return Promise.reject(new Error("No vehicle viewer configured."));
    const entries: TraceEntry[] = [
      {
        kind: "client-state",
        simulationTime: 0,
        clientId: client.id,
        clientName: client.name,
        state: action === "disconnect" ? "disconnected" : "connected",
      },
    ];
    if (action === "reconnect") {
      for (const viewId of ["live-map", "trip-history"])
        entries.push({
          kind: "client-subscription",
          simulationTime: 0,
          clientId: client.id,
          clientName: client.name,
          action: "subscribe",
          viewId,
          entityId: "car-17",
        });
    }
    return controller.intervene(
      action === "disconnect" ? "Disconnect viewer" : "Reconnect viewer",
      entries,
    );
  };
  return {
    ...controller,
    disconnect: () => viewer("disconnect"),
    reconnect: () => viewer("reconnect"),
    get state() {
      return controller.state;
    },
    get browser() {
      return browser;
    },
    get baseUrl() {
      return baseUrl;
    },
  };
}
