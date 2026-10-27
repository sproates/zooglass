import {
  createDemoController,
  type DemoRun,
  type DemoState,
} from "../../control/demo-controller.js";
import { startExternalBrowserHost } from "../../browser/external-browser-host.js";
import type { BrowserControlAction } from "../../browser/browser-host.js";
import { openScenarioSession } from "../../execution/scenario-session.js";
import { startZooGlassSession } from "../../service/zooglass-session.js";
import type { Scenario } from "../../scenario/scenario.js";
import { vehicleBrowserApplication } from "./vehicle-browser.js";
import {
  vehicleStepDescriptions,
  describeVehicleProgress,
} from "./vehicle-step-description.js";
import { externalVehicleControls } from "./external-vehicle-controls.js";
import type { FleetMapConfiguration } from "./fleet-assets.js";

interface ExternalVehicleOptions {
  bindAddress: string;
  map?: FleetMapConfiguration;
}

/** Live external demonstration; owned-browser mode remains the scripted client verifier. */
export async function createExternalVehicleDemo(
  scenario: Scenario,
  options: ExternalVehicleOptions,
) {
  const sourceScenario: Scenario = {
    ...scenario,
    clients: [],
    timeline: scenario.timeline.filter((entry) =>
      ["source-event", "view-check", "view-definition"].includes(entry.kind),
    ),
  };
  const controls = externalVehicleControls(scenario);
  const descriptions = vehicleStepDescriptions(sourceScenario);
  let manual = false;
  let closing: Promise<void> | undefined;
  let viewerAction: Promise<void> | undefined;
  const describe = (state: DemoState) => ({
    ...state,
    external: true,
    nextStep: describeVehicleProgress(state, descriptions),
    detail:
      state.phase === "complete"
        ? "Source and HTTP checks finished. External viewer behaviour is exploratory, not a scripted browser pass."
        : state.detail.replace(
            "All steps checked.",
            "Source and HTTP checks finished.",
          ),
  });
  const host = await startExternalBrowserHost({
    application: await vehicleBrowserApplication(true, options.map),
    bindAddress: options.bindAddress,
    onReady: controls.connect,
    onControllerLost() {
      if (controller?.state.playing) void controller.pause().catch(() => {});
    },
    onControl: (action, target) => command(action, target),
  });
  const controller = createDemoController(
    sourceScenario,
    async (signal): Promise<DemoRun> => {
      const service = await startZooGlassSession({
        views: scenario.views,
        signal,
      });
      let session: Awaited<ReturnType<typeof openScenarioSession>> | undefined;
      try {
        await host.replaceRun(service.baseUrl);
        session = await openScenarioSession(sourceScenario, service.baseUrl, {
          signal,
        });
        const activeSession = session;
        return {
          signal: AbortSignal.any([service.signal, host.signal]),
          async execute(entry) {
            await activeSession.execute(entry);
            if (entry.kind === "source-event")
              host.broadcast({
                kind: "vehicle-source-sent",
                sourceName: entry.sourceName,
                eventType: entry.type,
                entityId: entry.entityId,
                sequence: entry.payload.sequence,
                simulationTime: entry.simulationTime,
              });
          },
          publish: (state) => host.publish(describe(state)),
          async close() {
            // Retire routes while the old service is still present, then release it.
            try {
              await host.retireRun();
            } finally {
              try {
                await activeSession.close();
              } finally {
                await service.close();
              }
            }
          },
        };
      } catch (error) {
        try {
          await host.retireRun();
        } finally {
          try {
            await session?.close();
          } finally {
            await service.close();
          }
        }
        throw error;
      }
    },
  );
  async function command(action: BrowserControlAction, target?: string) {
    if (closing) throw new Error("Demo is closed.");
    if (["disconnect", "reconnect", "interrupt", "restore"].includes(action)) {
      if (
        manual ||
        controller.state.playing ||
        !["ready", "complete"].includes(controller.state.phase)
      )
        throw new Error("Viewer controls require a paused, idle run.");
      if (!target) throw new Error("Choose a target viewer.");
      const run = host.viewer(target);
      manual = true;
      viewerAction = controls.apply(
        run,
        action as "disconnect" | "reconnect" | "interrupt" | "restore",
      );
      try {
        await viewerAction;
      } finally {
        manual = false;
        viewerAction = undefined;
        host.publish(describe(controller.state));
      }
    } else {
      if (manual) throw new Error("A viewer action is still running.");
      await controller[action as "step" | "play" | "pause" | "reset"]();
    }
  }
  return {
    host,
    get state() {
      return describe(controller.state);
    },
    command,
    reset: () => command("reset"),
    close(): Promise<void> {
      return (closing ??= (async () => {
        try {
          await controller.close();
        } finally {
          await host.close();
          await viewerAction?.catch(() => {});
        }
      })());
    },
  };
}
