import {
  createDemoController,
  type DemoRun,
} from "../../control/demo-controller.js";
import {
  vehicleStepDescriptions,
  describeVehicleProgress,
} from "./vehicle-step-description.js";
import { startVehicleRun } from "./vehicle-run.js";
import type { TraceEntry } from "../../scenario/playback.js";
import type { Scenario } from "../../scenario/scenario.js";

export function createVehicleDemo(
  scenario: Scenario,
  options: { headless?: boolean } = {},
) {
  const descriptions = vehicleStepDescriptions(scenario);

  let browser:
    Awaited<ReturnType<typeof startVehicleRun>>["browser"] | undefined;
  let baseUrl: string | undefined;
  const controller = createDemoController(
    scenario,
    async (signal): Promise<DemoRun> => {
      const run = await startVehicleRun(scenario, {
        signal,
        headless: options.headless,
        keepOpenOnFailure: true,
        onControl: async (action, runId) => {
          if (browser?.host.runId !== runId)
            throw new Error("This run has been replaced.");

          if (action === "disconnect" || action === "reconnect")
            await viewer(action);
          else if (action === "interrupt" || action === "restore")
            await fault(action);
          else await controller[action]();
        },
      });

      browser = run.browser;
      baseUrl = run.baseUrl;

      try {
        const observed = await run.openScenario();
        console.log(`Browser host ready at ${run.browser.host.origin}`);

        return {
          signal: run.signal,
          execute: observed.execute,
          close: run.close,
          publish(state) {
            run.publish({
              ...state,
              nextStep: describeVehicleProgress(state, descriptions),
            });
          },
        };
      } catch (error) {
        await run.close();
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

  const fault = (action: "interrupt" | "restore") => {
    const client = scenario.clients.find((item) => item.id === "rider-app");
    if (!client)
      return Promise.reject(new Error("No vehicle viewer configured."));
    return controller.intervene(
      action === "interrupt" ? "Interrupt data route" : "Restore data route",
      [
        {
          kind: "data-connection-fault",
          simulationTime: 0,
          clientId: client.id,
          clientName: client.name,
          action: action === "interrupt" ? "break" : "restore",
        },
      ],
    );
  };

  return {
    ...controller,
    interrupt: () => fault("interrupt"),
    restore: () => fault("restore"),
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
