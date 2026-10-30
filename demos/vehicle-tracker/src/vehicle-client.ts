import { createRecoveringClient } from "./recovering-client.js";
import {
  receiveView,
  resetView,
  setConnection,
  subscriptionState,
} from "./view.js";
export type { Command } from "./subscription-client.js";

/** Bind the protocol client to the vehicle demo's views and presentation. */
export function createVehicleClient(
  dataPath: string,
  report: (event: Record<string, unknown>) => void,
  fail: (reason: string) => void,
) {
  resetView();
  return createRecoveringClient(dataPath, report, fail, {
    validateSubscription(viewId, entityId) {
      if (
        !viewId ||
        entityId !== "car-17" ||
        !["live-map", "trip-history"].includes(viewId)
      )
        throw new Error("Unknown vehicle view.");
    },
    connectionLostReason:
      "Connection lost. Stop and restart the demo to try again.",
    onConnection: setConnection,
    onSubscription(viewId, _entityId, state) {
      subscriptionState(viewId, state);
    },
    onView: receiveView,
  });
}
