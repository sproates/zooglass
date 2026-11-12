import { createSubscriptionClient } from "../../vehicle-tracker/src/subscription-client.js";
import { OrderModel, orderIds, views, type OrderView } from "./model.js";
import { renderOrders } from "./view.js";

/** Separate protected acceptance binding: every loss clears rendered and retained views. */
export function createProtectedOrderClient(endpoint: string, view: OrderView) {
  const model = new OrderModel();
  model.view = view;
  function clear() {
    model.snapshots.clear();
    model.beginConnection();
    model.connection = "Protected data cleared · fresh admission required";
    renderOrders(model);
  }
  clear();
  document.getElementById("startup")!.hidden = true;
  return createSubscriptionClient(
    endpoint,
    () => {},
    () => {},
    {
      clearProtectedData: clear,
      connectionLostReason:
        "Protected connection closed; fresh admission required.",
      validateSubscription(viewId, entityId) {
        if (
          !views.includes(viewId as OrderView) ||
          !orderIds.includes(entityId ?? "")
        )
          throw new Error("Unknown Order view.");
      },
      onConnection(state, reason) {
        model.connected = state === "connected";
        model.connection = reason ?? state;
        renderOrders(model);
      },
      onSubscription() {},
      onSnapshot(snapshot) {
        model.accept(snapshot);
        renderOrders(model);
      },
    },
  );
}
