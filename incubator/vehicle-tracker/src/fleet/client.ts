import { createFleetMap, type MapConfiguration } from "./map.js";
import { createRecoveringClient } from "../recovering-client.js";
import { createFleetModel, parseManifest } from "./model.js";
import { createFleetView } from "./view.js";

export function createFleetClient(
  dataPath: string,
  report: (event: Record<string, unknown>) => void,
  fail: (reason: string) => void,
  manifest: unknown,
  mapConfiguration: MapConfiguration,
) {
  const model = createFleetModel(parseManifest(manifest));
  const select = (entityId: string) => {
    model.select(entityId);
    render();
  };
  const view = createFleetView(model, select);
  const map = createFleetMap(model, mapConfiguration, select);
  function render() {
    view.render();
    map.render();
  }

  return createRecoveringClient(dataPath, report, fail, {
    validateSubscription(viewId, entityId) {
      if (!viewId || !entityId)
        throw new Error("Missing fleet subscription identity.");
      model.get(viewId, entityId);
    },
    connectionLostReason: "Fleet connection lost. Reset the demo to try again.",
    onConnection(state, reason) {
      model.setConnection(state, reason);
      render();
    },
    onSubscription(viewId, entityId, state) {
      model.subscription(viewId, entityId, state);
      render();
    },
    onView(viewId, entityId, data) {
      model.receive(viewId, entityId, data);
      render();
    },
  });
}
