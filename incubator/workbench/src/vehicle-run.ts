import { DemoCleanupError } from "./demo-controller.js";
import { observeVehicleSession } from "./vehicle-observer.js";
import { startZooGlassSession } from "./zooglass-session.js";
import { startVehicleBrowserSession } from "./vehicle-browser.js";
import {
  openScenarioSession,
  type ScenarioSession,
} from "./scenario-session.js";
import type { Scenario } from "./scenario.js";

type BrowserOptions = Parameters<typeof startVehicleBrowserSession>[1];

/** Own the vehicle service, browser and scenario in acquisition order. */
export async function startVehicleRun(
  scenario: Scenario,
  options: BrowserOptions,
) {
  let service: Awaited<ReturnType<typeof startZooGlassSession>> | undefined;
  let browser:
    Awaited<ReturnType<typeof startVehicleBrowserSession>> | undefined;
  let session: ScenarioSession | undefined;
  const scenarioController = new AbortController();
  let scenarioClosing: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  let opening: Promise<ReturnType<typeof observeVehicleSession>> | undefined;

  // Separate scenario closure keeps a failed automatic run available for inspection.
  const closeScenario = () =>
    (scenarioClosing ??= Promise.resolve().then(async () => {
      scenarioController.abort(new Error("Vehicle scenario closed."));
      await opening?.catch(() => {});
      await session?.close();
    }));
  const close = () =>
    (closing ??= Promise.resolve().then(async () => {
      const errors: unknown[] = [];
      // Attempt every cleanup even if an earlier resource fails to close.
      for (const release of [
        closeScenario,
        () => browser?.close(),
        () => service?.close(),
      ]) {
        try {
          await release();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length)
        throw new DemoCleanupError("Could not close the demo session.", {
          cause: new AggregateError(errors),
        });
    }));
  try {
    service = await startZooGlassSession({
      views: scenario.views,
      signal: options.signal,
    });
    browser = await startVehicleBrowserSession(service.baseUrl, {
      ...options,
      signal: service.signal,
    });
    const ownedService = service;
    const ownedBrowser = browser;
    return {
      browser: ownedBrowser,
      baseUrl: ownedService.baseUrl,
      signal: ownedBrowser.signal,
      publish: ownedBrowser.host.publish,
      // Opening separately lets the automatic caller inspect scenario setup failures.
      openScenario() {
        if (closing || scenarioClosing)
          return Promise.reject(new Error("Vehicle run is closing."));
        return (opening ??= (async () => {
          session = await openScenarioSession(scenario, ownedService.baseUrl, {
            signal: AbortSignal.any([
              ownedBrowser.signal,
              scenarioController.signal,
            ]),
            createClientExecutor(client) {
              if (client.id !== ownedBrowser.host.clientId)
                throw new Error("Unbound browser client.");
              return ownedBrowser.host.executor;
            },
          });
          return observeVehicleSession(
            session,
            ownedBrowser.page,
            ownedBrowser.signal,
          );
        })());
      },
      closeScenario,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
